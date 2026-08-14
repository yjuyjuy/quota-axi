import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderAuthStatus,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  successProvider,
} from "./common.js";

/**
 * Qoder provider (ADR 0031, Phase 2).
 *
 * Qoder is Alibaba's agentic coding IDE/CLI. Its paid plans meter premium model
 * usage in monthly Credits: Pro ($20) grants 2,000, Pro+ ($60) grants 6,000, and
 * Ultra ($200) grants 20,000, all resetting to zero at the billing-period end.
 * Subscribers can also stack prepaid Credit Packs (1,500 each) on top, so the
 * effective monthly budget can exceed the base plan number.
 *
 * The only readable local Qoder state is the OAuth credential that `qodercli
 * login` writes to `~/.qoder/.auth/user`. That file proves sign-in but carries
 * no credit balance. The two sources that DO expose an observed balance are both
 * off-limits under quota-axi's security posture:
 *   - `GET /api/v2/me/usages/big_model_credits` authenticates with browser
 *     session cookies (importing browser cookies is banned), and
 *   - the qodercli SDK `getUsage()` requires spawning the qodercli binary
 *     (launching the provider CLI is avoided; for a metered CLI it can also
 *     consume the very quota being measured).
 *
 * So this provider reports the plan's DECLARED monthly credit window as
 * declared-window telemetry: the credit budget for the resolved plan, a fresh
 * reset one cycle out, and percentRemaining. That is enough to make a Qoder
 * account observable, which is the ADR 0031 precondition for the orchestrator to
 * route to it at all (blind accounts are banned).
 *
 * When a readable balance source later appears, this adapter should fold the
 * observed used/remaining credits into `percentUsed`/`percentRemaining` on the
 * same `monthly` window, and reflect stacked Credit Packs by raising the
 * declared budget, without changing the window identity.
 */

const QODER_LABEL = "Qoder";
const AUTH_SOURCE = "auth-user";

/** Declared monthly cycle length; a 30-day month is the billing-period basis. */
export const QODER_MONTH_SECONDS = 30 * 24 * 60 * 60;

export type QoderPlan = "pro" | "pro_plus" | "ultra";

/** Declared monthly premium-model credit budget per plan, from Qoder pricing. */
const PLAN_CREDIT_BUDGET: Record<QoderPlan, number> = {
  pro: 2000,
  pro_plus: 6000,
  ultra: 20000,
};

export function planCreditBudget(plan: QoderPlan): number {
  return PLAN_CREDIT_BUDGET[plan];
}

type QoderCredential = {
  /** Absolute expiry epoch (ms) for an oauth credential, when present. */
  expiresAtMs?: number;
  /** Subscription hint carried by some auth records, used only for plan sizing. */
  subscriptionType?: string;
};

type CredentialState =
  | {
      status: "available";
      credential: QoderCredential;
      source: AuthSourceReport;
    }
  | { status: "expired"; source: AuthSourceReport }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

export const qoderAdapter: ProviderAdapter = {
  id: "qoder",
  label: QODER_LABEL,
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const credentialState = readCredentialState();

  if (credentialState.status === "available") {
    attempts.push({
      source: AUTH_SOURCE,
      status: "success",
      credentialPresent: true,
    });
    const plan = resolvePlan(
      credentialState.credential.subscriptionType,
      process.env.QODER_PLAN,
    );
    const success = successProvider({
      provider: "qoder",
      label: QODER_LABEL,
      source: "oauth",
      plan,
      windows: buildDeclaredWindows(plan, new Date()),
      credits: { remaining: planCreditBudget(plan), unit: "credits" },
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    return {
      ...success,
      state: { ...success.state, authStatus: "usable" },
    };
  }

  const { error, authStatus, status } = describeUnavailable(
    credentialState.status,
  );
  attempts.push({
    source: AUTH_SOURCE,
    status: credentialState.status === "expired" ? "failed" : "skipped",
    error,
    credentialPresent: credentialState.status === "expired",
  });

  const cached = readCachedProvider("qoder");
  if (cached) {
    const stale = staleFromCache(
      cached,
      error,
      sourceNames(attempts),
      attempts,
    );
    return { ...stale, state: { ...stale.state, authStatus } };
  }

  const failed = failedProvider({
    provider: "qoder",
    label: QODER_LABEL,
    status,
    error,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  return { ...failed, state: { ...failed.state, authStatus } };
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return { provider: "qoder", sources: [readCredentialState().source] };
}

/**
 * Build the plan's declared monthly credit window relative to `now`. With no
 * readable balance source, the window reports 0% used (100% remaining) and a
 * reset one full cycle out. Observed usage would later replace those defaults in
 * place without changing the window identity.
 */
export function buildDeclaredWindows(
  plan: QoderPlan,
  now: Date,
): QuotaWindow[] {
  return [
    {
      id: "monthly",
      label: "Monthly credits",
      kind: "credits",
      percentUsed: 0,
      percentRemaining: 100,
      windowSeconds: QODER_MONTH_SECONDS,
      resetsAt: new Date(
        now.getTime() + QODER_MONTH_SECONDS * 1000,
      ).toISOString(),
    },
  ];
}

/**
 * Resolve the Qoder plan from an explicit `QODER_PLAN` override first, then an
 * auth-file subscription hint, defaulting to `pro`. Any unrecognized value
 * falls through to the next source rather than guessing a higher tier.
 */
export function resolvePlan(
  subscriptionHint: string | undefined,
  override: string | undefined,
): QoderPlan {
  return normalizePlan(override) ?? normalizePlan(subscriptionHint) ?? "pro";
}

function normalizePlan(value: string | undefined): QoderPlan | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (normalized.includes("ultra")) return "ultra";
  if (
    normalized.includes("pro+") ||
    normalized.includes("pro plus") ||
    normalized.includes("pro_plus") ||
    normalized.includes("proplus") ||
    normalized.includes("professional_plus") ||
    normalized.includes("professional plus")
  ) {
    return "pro_plus";
  }
  if (normalized.includes("pro") || normalized.includes("professional")) {
    return "pro";
  }
  return undefined;
}

function describeUnavailable(status: "expired" | "missing" | "invalid"): {
  error: string;
  authStatus: ProviderAuthStatus;
  status: ProviderQuota["state"]["status"];
} {
  if (status === "expired") {
    return {
      error: "Qoder credentials expired",
      authStatus: "expired_refreshable",
      status: "auth_required",
    };
  }
  return {
    error: "Qoder sign-in required",
    authStatus: "unusable",
    status: "auth_required",
  };
}

function readCredentialState(): CredentialState {
  const inline = process.env.QODER_AUTH_CONTENT;
  if (inline !== undefined && inline.trim() !== "") {
    return extractCredentialState(parseInline(inline), "QODER_AUTH_CONTENT");
  }
  const path = qoderAuthFile();
  return extractCredentialState(readJsonFileResult(path), path);
}

function parseInline(inline: string): JsonFileReadResult {
  try {
    return { status: "success", value: JSON.parse(inline) };
  } catch {
    return { status: "invalid", error: "json_parse_error" };
  }
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: { source: AUTH_SOURCE, path, status: "missing" },
    };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: {
        source: AUTH_SOURCE,
        path,
        status: "invalid",
        error: raw.error,
      },
    };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "invalid",
      source: { source: AUTH_SOURCE, path, status: "invalid" },
    };

  const accessToken =
    stringValue(data.accessToken) ?? stringValue(data.access_token);
  if (!accessToken)
    return {
      status: "invalid",
      source: { source: AUTH_SOURCE, path, status: "invalid" },
    };

  const expiresAtMs = numberValue(data.expiresAt ?? data.expires_at);
  if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
    return {
      status: "expired",
      source: { source: AUTH_SOURCE, path, status: "expired" },
    };
  }
  const subscriptionType =
    stringValue(data.subscriptionType) ?? stringValue(data.userType);
  return {
    status: "available",
    credential: { expiresAtMs, subscriptionType },
    source: { source: AUTH_SOURCE, path, status: "available" },
  };
}

function qoderAuthFile(): string {
  if (process.env.QODER_AUTH_JSON) return process.env.QODER_AUTH_JSON;
  const home = process.env.QODER_HOME || join(homedir(), ".qoder");
  return join(home, ".auth", "user");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

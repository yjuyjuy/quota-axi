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
 * OpenCode Go provider (ADR 0031, Phase 2).
 *
 * OpenCode Go is a flat-rate subscription whose usage is capped by
 * dollar-value windows published by the vendor. OpenCode stores no local
 * balance file and exposes no documented public usage/balance endpoint (the
 * console tracks spend server-side only), so this provider reports the plan's
 * DECLARED static windows as declared-window telemetry: each window carries the
 * published dollar cap, its cycle length, a fresh reset timestamp, and
 * percentRemaining. That is enough to make an OpenCode account observable, which
 * is the ADR 0031 precondition for the orchestrator to route to it at all
 * (blind accounts are banned).
 *
 * When OpenCode later exposes a readable spend source, this adapter should fold
 * observed spend into `spentUsd`/`percentUsed` on the same windows without
 * changing their identities.
 */

const OPENCODE_LABEL = "OpenCode Go";
/** Provider key OpenCode writes for the Zen/Go managed service in auth.json. */
const OPENCODE_AUTH_KEY = "opencode";
const AUTH_SOURCE = "auth-json";

export const OPENCODE_SESSION_SECONDS = 5 * 60 * 60;
export const OPENCODE_WEEK_SECONDS = 7 * 24 * 60 * 60;
/** Declared monthly cycle length; a 30-day month is the vendor's stated basis. */
export const OPENCODE_MONTH_SECONDS = 30 * 24 * 60 * 60;

type DeclaredWindow = {
  id: string;
  label: string;
  kind: QuotaWindow["kind"];
  limitUsd: number;
  windowSeconds: number;
};

/** Account-wide dollar caps for the Go plan, from https://opencode.ai/docs/go. */
const ACCOUNT_WINDOWS: DeclaredWindow[] = [
  {
    id: "five_hour",
    label: "5 hour",
    kind: "session",
    limitUsd: 12,
    windowSeconds: OPENCODE_SESSION_SECONDS,
  },
  {
    id: "weekly",
    label: "Weekly",
    kind: "weekly",
    limitUsd: 30,
    windowSeconds: OPENCODE_WEEK_SECONDS,
  },
  {
    id: "monthly",
    label: "Monthly",
    kind: "monthly",
    limitUsd: 60,
    windowSeconds: OPENCODE_MONTH_SECONDS,
  },
];

/**
 * Models the Go plan caps at $15 of monthly usage rather than the default $60
 * (higher-cost models the vendor could not discount as deeply). Their
 * per-model monthly cap is an additional bound on top of the account windows.
 * Source: the per-model "Usage" column at https://opencode.ai/docs/go.
 */
const MODEL_CAP_USD = 15;
const CAPPED_MODELS: { id: string; label: string }[] = [
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "gpt-5.6-luna", label: "GPT 5.6 Luna" },
  { id: "glm-5.3", label: "GLM-5.3" },
  { id: "kimi-k3", label: "Kimi K3" },
  { id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
  { id: "qwen3.8-max", label: "Qwen3.8 Max" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

type OpencodeCredential = {
  type: "api" | "oauth" | "wellknown";
  /** Absolute expiry epoch (ms) for an oauth credential, when present. */
  expiresAtMs?: number;
};

type CredentialState =
  | {
      status: "available";
      credential: OpencodeCredential;
      source: AuthSourceReport;
    }
  | { status: "expired"; source: AuthSourceReport }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

export const opencodeAdapter: ProviderAdapter = {
  id: "opencode",
  label: OPENCODE_LABEL,
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
    const success = successProvider({
      provider: "opencode",
      label: OPENCODE_LABEL,
      source: "oauth",
      plan: "go",
      windows: buildDeclaredWindows(new Date()),
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

  const cached = readCachedProvider("opencode");
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
    provider: "opencode",
    label: OPENCODE_LABEL,
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
  return { provider: "opencode", sources: [readCredentialState().source] };
}

/**
 * Build the plan's declared usage windows relative to `now`. With no readable
 * spend source, each window reports 0% used (100% remaining) and a reset one
 * full cycle out. Observed spend would later replace those defaults in place.
 */
export function buildDeclaredWindows(now: Date): QuotaWindow[] {
  const windows: QuotaWindow[] = ACCOUNT_WINDOWS.map((declared) =>
    declaredWindow(declared, now),
  );
  for (const model of CAPPED_MODELS) {
    windows.push(
      declaredWindow(
        {
          id: `model:${model.id}`,
          label: `${model.label} (monthly)`,
          kind: "model",
          limitUsd: MODEL_CAP_USD,
          windowSeconds: OPENCODE_MONTH_SECONDS,
        },
        now,
      ),
    );
  }
  return windows;
}

function declaredWindow(declared: DeclaredWindow, now: Date): QuotaWindow {
  return {
    id: declared.id,
    label: declared.label,
    kind: declared.kind,
    percentUsed: 0,
    percentRemaining: 100,
    spentUsd: 0,
    limitUsd: declared.limitUsd,
    windowSeconds: declared.windowSeconds,
    resetsAt: new Date(
      now.getTime() + declared.windowSeconds * 1000,
    ).toISOString(),
  };
}

function describeUnavailable(status: "expired" | "missing" | "invalid"): {
  error: string;
  authStatus: ProviderAuthStatus;
  status: ProviderQuota["state"]["status"];
} {
  if (status === "expired") {
    return {
      error: "OpenCode credentials expired",
      authStatus: "expired_refreshable",
      status: "auth_required",
    };
  }
  return {
    error: "OpenCode sign-in required",
    authStatus: "unusable",
    status: "auth_required",
  };
}

function readCredentialState(): CredentialState {
  const inline = process.env.OPENCODE_AUTH_CONTENT;
  if (inline !== undefined && inline.trim() !== "") {
    return extractCredentialState(parseInline(inline), "OPENCODE_AUTH_CONTENT");
  }
  const path = opencodeAuthFile();
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
  const entry = objectValue(data?.[OPENCODE_AUTH_KEY]);
  if (!entry)
    return {
      status: "missing",
      source: { source: AUTH_SOURCE, path, status: "missing" },
    };

  const type = stringValue(entry.type);
  if (type === "api" || type === "wellknown") {
    const key = stringValue(entry.key);
    if (!key)
      return {
        status: "invalid",
        source: { source: AUTH_SOURCE, path, status: "invalid" },
      };
    return {
      status: "available",
      credential: { type },
      source: { source: AUTH_SOURCE, path, status: "available" },
    };
  }
  if (type === "oauth") {
    const access = stringValue(entry.access);
    if (!access)
      return {
        status: "invalid",
        source: { source: AUTH_SOURCE, path, status: "invalid" },
      };
    const expiresAtMs = numberValue(entry.expires);
    if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
      return {
        status: "expired",
        source: { source: AUTH_SOURCE, path, status: "expired" },
      };
    }
    return {
      status: "available",
      credential: { type: "oauth", expiresAtMs },
      source: { source: AUTH_SOURCE, path, status: "available" },
    };
  }
  return {
    status: "invalid",
    source: { source: AUTH_SOURCE, path, status: "invalid" },
  };
}

function opencodeAuthFile(): string {
  if (process.env.OPENCODE_AUTH_JSON) return process.env.OPENCODE_AUTH_JSON;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
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

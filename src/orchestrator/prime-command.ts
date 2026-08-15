import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { collapseHome, readJsonFileResult } from "../lib/fs.js";
import { nowIso } from "../lib/time.js";
import { readThroughUsageCache } from "../usage-cache.js";
import { PROVIDERS } from "../providers/index.js";
import { PROVIDER_IDS, type ProviderId } from "../types.js";
import { policyFilePath, registryFilePath } from "./paths.js";
import {
  planPriming,
  primingRoutePreference,
  runPriming,
  syntheticPingFor,
  type PlanPrimingRequest,
  type PrimeProbeResult,
  type PrimingProber,
  type PrimingResponse,
  type PrimingTelemetry,
} from "./priming.js";
import type { RegistryAccount } from "./types.js";
import { validate } from "./validate.js";
import { readYamlFile } from "./yaml.js";

/**
 * `quota-axi prime`: the strategy-gated priming pass (ADR 0031, Phase 2).
 *
 * Priming keeps every fixed-cost account primed - auth verified and telemetry
 * fresh within one window cycle - so the pure `decide` can trust their state
 * when routing. It is strictly gated by `policy.priming_strategy.enabled`: with
 * priming OFF there is ZERO synthetic traffic. When priming is ON and the fleet
 * has real work pending, it prefers routing that work to under-used fixed-cost
 * accounts (a `decide`-style preference this command reports) so the minimal
 * synthetic ping is the last resort, issued only when the fleet is idle.
 *
 * Honest rationale (ADR 0031): priming ONLY verifies auth and freshens
 * telemetry. It never advances or resets any provider reset clock.
 *
 * The synthetic ping is the cheapest safe call per provider: the provider's own
 * read-only usage read, routed through the SAME Phase 1 shared usage cache the
 * `quota` command uses (`readThroughUsageCache`), so priming adds no second
 * fetch path. The command is otherwise read-only: it writes no credential store,
 * records no tripwire, and never routes or switches.
 *
 * Telemetry is supplied as a file (mirroring `decide` and `switch`), because a
 * live per-account fetch requires resolving each account's distinct credential,
 * which is out of scope here. `--dry-run` previews the intended pings without
 * issuing any.
 */

export type PrimeFlags = {
  json: boolean;
  dryRun: boolean;
  registryPath: string;
  policyPath: string;
  telemetryPath: string;
};

export function parsePrimeFlags(args: string[]): PrimeFlags {
  let json = false;
  let dryRun = false;
  let registryPath: string | undefined;
  let policyPath: string | undefined;
  let telemetryPath: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--registry") {
      registryPath = requireValue(args, ++index, "--registry");
      continue;
    }
    if (arg.startsWith("--registry=")) {
      registryPath = arg.slice("--registry=".length);
      continue;
    }
    if (arg === "--policy") {
      policyPath = requireValue(args, ++index, "--policy");
      continue;
    }
    if (arg.startsWith("--policy=")) {
      policyPath = arg.slice("--policy=".length);
      continue;
    }
    if (arg === "--telemetry") {
      telemetryPath = requireValue(args, ++index, "--telemetry");
      continue;
    }
    if (arg.startsWith("--telemetry=")) {
      telemetryPath = arg.slice("--telemetry=".length);
      continue;
    }
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `quota-axi prime --help` for supported flags",
    ]);
  }

  if (telemetryPath === undefined) {
    throw new AxiError(
      "prime requires --telemetry <path>",
      "VALIDATION_ERROR",
      [
        "Pass --telemetry pointing at a JSON file of per-account priming telemetry",
      ],
    );
  }

  return {
    json,
    dryRun,
    registryPath: registryPath ?? registryFilePath(),
    policyPath: policyPath ?? policyFilePath(),
    telemetryPath,
  };
}

export type PrimeCommandDeps = {
  /** The synthetic-ping prober; injected for tests. Defaults to the shared cache. */
  prober?: PrimingProber;
  /** The clock; injected for tests. Defaults to wall-clock ISO. */
  now?: () => string;
};

export async function primeCommand(
  args: string[],
  _context?: unknown,
  deps: PrimeCommandDeps = {},
): Promise<string> {
  void _context;
  const flags = parsePrimeFlags(args);
  const now = deps.now?.() ?? nowIso();

  const validation = validate(
    readYamlFile(flags.registryPath),
    readYamlFile(flags.policyPath),
  );
  if (!validation.valid || !validation.registry || !validation.policy) {
    process.exitCode = 1;
    if (flags.json) {
      return JSON.stringify(
        { generatedAt: now, ok: false, issues: validation.issues },
        null,
        2,
      );
    }
    const summary = encode({
      registry: collapseHome(flags.registryPath),
      policy: collapseHome(flags.policyPath),
      valid: false,
      issueCount: validation.issues.length,
    });
    const rows = validation.issues.map((item) => ({
      file: item.file,
      path: item.path === "" ? "(root)" : item.path,
      code: item.code,
      message: item.message,
    }));
    return `${summary}\n${encode({ issues: rows })}`;
  }

  const telemetryFile = readTelemetry(flags.telemetryPath);

  const request: PlanPrimingRequest = {
    registry: validation.registry,
    policy: validation.policy,
    telemetry: telemetryFile.telemetry,
    ...(telemetryFile.realWorkPending !== undefined
      ? { realWorkPending: telemetryFile.realWorkPending }
      : {}),
    ...(telemetryFile.provider ? { provider: telemetryFile.provider } : {}),
  };

  const plan = planPriming(request);
  const routePreference = primingRoutePreference(request);
  const prober = deps.prober ?? sharedCacheProber();

  const response = await runPriming({
    plan,
    registry: validation.registry,
    prober,
    now,
    dryRun: flags.dryRun,
  });

  if (response.outcomes.some((outcome) => outcome.action === "failed")) {
    process.exitCode = 1;
  }

  return flags.json
    ? JSON.stringify(
        { ...response, routePreference, synthetic: syntheticCatalog(response) },
        null,
        2,
      )
    : renderPrimeToon(flags, response, routePreference);
}

/**
 * The real prober: the cheapest safe synthetic call is the provider's own
 * read-only usage read, routed through the SAME shared usage cache the `quota`
 * command uses, so priming issues no second fetch path. A fresh result means
 * auth verified and telemetry freshened; an auth-required or error result is a
 * failed ping. It never mutates any provider state.
 */
export function sharedCacheProber(): PrimingProber {
  return async (account: RegistryAccount): Promise<PrimeProbeResult> => {
    const providerId = account.provider;
    if (!isProviderId(providerId)) {
      return {
        ok: false,
        authVerified: false,
        error: `unsupported provider: ${providerId}`,
      };
    }
    const adapter = PROVIDERS[providerId];
    try {
      const quota = await readThroughUsageCache(providerId, () =>
        adapter.fetchQuota({ allowKeychainPrompt: false }),
      );
      const status = quota.state.status;
      const authVerified =
        status === "fresh" ||
        status === "stale" ||
        quota.state.authStatus === "usable";
      if (status === "fresh" || status === "stale") {
        const fetchedAt =
          quota.state.usageCache?.fetchedAt ??
          quota.state.refreshedAt ??
          nowIso();
        return { ok: true, authVerified, fetchedAt };
      }
      return {
        ok: false,
        authVerified,
        error: quota.state.error ?? `provider status ${status}`,
      };
    } catch (error) {
      return {
        ok: false,
        authVerified: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** The telemetry file shape the CLI accepts. */
type TelemetryFile = {
  provider?: string;
  realWorkPending?: boolean;
  telemetry: Record<string, PrimingTelemetry>;
};

function readTelemetry(path: string): TelemetryFile {
  const result = readJsonFileResult(path);
  if (result.status === "missing") {
    throw new AxiError(
      `telemetry file not found: ${collapseHome(path)}`,
      "VALIDATION_ERROR",
    );
  }
  if (result.status === "invalid") {
    throw new AxiError(
      `telemetry file could not be parsed (${result.error})`,
      "VALIDATION_ERROR",
    );
  }
  const value = result.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AxiError(
      "telemetry file must be a JSON object with a `telemetry` map",
      "VALIDATION_ERROR",
    );
  }
  const record = value as Record<string, unknown>;
  const telemetry = record.telemetry;
  if (
    telemetry === null ||
    typeof telemetry !== "object" ||
    Array.isArray(telemetry)
  ) {
    throw new AxiError(
      "telemetry file must contain a `telemetry` object keyed by account id",
      "VALIDATION_ERROR",
    );
  }
  const file: TelemetryFile = {
    telemetry: telemetry as Record<string, PrimingTelemetry>,
  };
  if (typeof record.provider === "string") file.provider = record.provider;
  if (typeof record.realWorkPending === "boolean") {
    file.realWorkPending = record.realWorkPending;
  }
  return file;
}

/** The cheapest safe synthetic call per provider that appears in this run. */
function syntheticCatalog(
  response: PrimingResponse,
): { provider: string; call: string; rationale: string }[] {
  const providers = new Set(response.outcomes.map((o) => o.provider));
  return [...providers].sort().map((provider) => syntheticPingFor(provider));
}

function renderPrimeToon(
  flags: PrimeFlags,
  response: PrimingResponse,
  routePreference: ReturnType<typeof primingRoutePreference>,
): string {
  const summary = encode({
    registry: collapseHome(flags.registryPath),
    policy: collapseHome(flags.policyPath),
    schemaVersion: response.schemaVersion,
    provider: response.provider,
    enabled: response.enabled,
    dryRun: response.dryRun,
    syntheticPingsIssued: response.syntheticPingsIssued,
  });
  const rows = response.outcomes.map((outcome) => ({
    account: outcome.account,
    status: outcome.status,
    action: outcome.action,
    authVerified: outcome.authVerified ?? "",
    fetchedAt: outcome.fetchedAt ?? "",
    error: outcome.error ?? "",
  }));
  const parts = [summary, encode({ outcomes: rows })];
  if (routePreference.length > 0) {
    const prefRows = routePreference.map((preference, index) => ({
      rank: index + 1,
      account: preference.account,
      minRemaining: preference.minRemainingPercent ?? "(unknown)",
      needsWork: preference.needsWork,
    }));
    parts.push(encode({ routePreference: prefRows }));
  }
  const synthetic = syntheticCatalog(response);
  if (synthetic.length > 0) {
    parts.push(encode({ syntheticPing: synthetic }));
  }
  return parts.join("\n");
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR", [
      `Pass ${flag}=... if the value begins with --`,
    ]);
  }
  return value;
}

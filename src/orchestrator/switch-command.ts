import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { collapseHome, readJsonFileResult } from "../lib/fs.js";
import { nowIso } from "../lib/time.js";
import {
  createCswapSurface,
  type ClaudeHarnessSurface,
} from "./claude-surface.js";
import {
  decide,
  type AccountObservation,
  type DecideRequest,
  type DecisionResponse,
  type SessionInput,
} from "./decide.js";
import {
  createJcodeCliSurface,
  type JcodeSessionSurface,
} from "./jcode-surface.js";
import { policyFilePath, registryFilePath } from "./paths.js";
import { CLAUDE_HARNESS, runSwitch, type SwitchResponse } from "./switch.js";
import { TripwireStore, type TripwireRecord } from "./tripwire-store.js";
import { validate } from "./validate.js";
import { readYamlFile } from "./yaml.js";

/**
 * `quota-axi switch`: the fenced mutation verb (ADR 0031, Phase 1).
 *
 * `switch` is the ONE clearly-named mutation verb and the ONLY writer in the
 * whole orchestrator. `validate` and `decide` are strictly read-only; `switch`
 * is the single fence where actuation happens. It consumes a decision (a
 * `--decision <path>` file that `decide` already produced, OR one re-run
 * internally from `--registry` + `--policy` + `--observations`), then drives the
 * jcode live-session control surface to move each session onto its chosen
 * account and records tripwire state so an exhausted account stays out until its
 * recovery deadline.
 *
 * The recorded tripwires are folded back into the observations the internal
 * `decide` sees (as `exhaustedUntil`), which is exactly how a later `decide`
 * run keeps a tripped account out: `switch` writes the store, `decide` reads it
 * through its observations feed. When a decision file is supplied directly, that
 * decision is honored as-is and no internal `decide` runs.
 *
 * `--dry-run` resolves the decision and prints the intended per-scope moves but
 * issues no jcode calls and writes no tripwire state, because this is the
 * mutating verb and a caller wants to preview it.
 */

/** Default tripwire recovery window when the caller does not set one (24h). */
export const DEFAULT_RECOVER_AFTER_SECONDS = 24 * 60 * 60;

export type SwitchFlags = {
  json: boolean;
  dryRun: boolean;
  registryPath: string;
  policyPath: string;
  observationsPath?: string;
  decisionPath?: string;
  tripwiresPath?: string;
  jcodeBinary?: string;
  cswapBinary?: string;
  recoverAfterSeconds: number;
};

export function parseSwitchFlags(args: string[]): SwitchFlags {
  let json = false;
  let dryRun = false;
  let registryPath: string | undefined;
  let policyPath: string | undefined;
  let observationsPath: string | undefined;
  let decisionPath: string | undefined;
  let tripwiresPath: string | undefined;
  let jcodeBinary: string | undefined;
  let cswapBinary: string | undefined;
  let recoverAfterSeconds: number | undefined;

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
    const inline = matchInline(arg);
    if (inline) {
      assign(inline.flag, inline.value);
      continue;
    }
    const flag = matchValueFlag(arg);
    if (flag) {
      assign(flag, requireValue(args, ++index, flag));
      continue;
    }
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `quota-axi switch --help` for supported flags",
    ]);
  }

  function assign(flag: string, value: string): void {
    switch (flag) {
      case "--registry":
        registryPath = value;
        break;
      case "--policy":
        policyPath = value;
        break;
      case "--observations":
        observationsPath = value;
        break;
      case "--decision":
        decisionPath = value;
        break;
      case "--tripwires":
        tripwiresPath = value;
        break;
      case "--jcode-binary":
        jcodeBinary = value;
        break;
      case "--cswap-binary":
        cswapBinary = value;
        break;
      case "--recover-after-seconds":
        recoverAfterSeconds = parseRecoverAfter(value);
        break;
    }
  }

  if (decisionPath === undefined && observationsPath === undefined) {
    throw new AxiError(
      "switch requires a decision: pass --decision <path> or --observations <path>",
      "VALIDATION_ERROR",
      [
        "Pass --decision pointing at a decision JSON that `decide` produced,",
        "or --observations pointing at per-account telemetry to re-run decide internally",
      ],
    );
  }

  const flags: SwitchFlags = {
    json,
    dryRun,
    registryPath: registryPath ?? registryFilePath(),
    policyPath: policyPath ?? policyFilePath(),
    recoverAfterSeconds: recoverAfterSeconds ?? DEFAULT_RECOVER_AFTER_SECONDS,
  };
  if (observationsPath !== undefined) flags.observationsPath = observationsPath;
  if (decisionPath !== undefined) flags.decisionPath = decisionPath;
  if (tripwiresPath !== undefined) flags.tripwiresPath = tripwiresPath;
  if (jcodeBinary !== undefined) flags.jcodeBinary = jcodeBinary;
  if (cswapBinary !== undefined) flags.cswapBinary = cswapBinary;
  return flags;
}

export type SwitchCommandDeps = {
  /** The jcode surface; injected for tests. Defaults to the real CLI adapter. */
  surface?: JcodeSessionSurface;
  /**
   * The claude-harness surface; injected for tests. Defaults to the real
   * cswap-backed adapter. Used only when the decision harness is `claude`.
   */
  claudeSurface?: ClaudeHarnessSurface;
  /** The tripwire store; injected for tests. Defaults to the on-disk store. */
  tripwireStore?: TripwireStore;
  /** The clock; injected for tests. Defaults to wall-clock ISO. */
  now?: () => string;
};

export async function switchCommand(
  args: string[],
  _context?: unknown,
  deps: SwitchCommandDeps = {},
): Promise<string> {
  void _context;
  const flags = parseSwitchFlags(args);
  const now = deps.now?.() ?? nowIso();

  const tripwireStore =
    deps.tripwireStore ??
    new TripwireStore(flags.tripwiresPath ? { path: flags.tripwiresPath } : {});

  const resolved = resolveDecision(flags, now, tripwireStore);
  if ("error" in resolved) {
    process.exitCode = 1;
    return flags.json
      ? JSON.stringify(resolved.error, null, 2)
      : renderErrorToon(resolved.error);
  }

  // Route on the decision harness: the claude harness is a global cswap flip,
  // every other harness drives the jcode live-session surface. Only the surface
  // the decision needs is constructed, so a claude switch never spawns jcode and
  // a jcode switch never spawns cswap.
  const isClaude = resolved.decision.harness === CLAUDE_HARNESS;
  const runOptions = {
    decision: resolved.decision,
    recordTripwires: (updates: Record<string, TripwireRecord>) =>
      tripwireStore.record(updates),
    now,
    recoverAfterSeconds: flags.recoverAfterSeconds,
    dryRun: flags.dryRun,
  };

  const response = isClaude
    ? await runSwitch({
        ...runOptions,
        claudeSurface:
          deps.claudeSurface ??
          createCswapSurface(
            flags.cswapBinary ? { binary: flags.cswapBinary } : {},
          ),
      })
    : await runSwitch({
        ...runOptions,
        surface:
          deps.surface ??
          createJcodeCliSurface(
            flags.jcodeBinary ? { binary: flags.jcodeBinary } : {},
          ),
      });

  if (response.outcomes.some((outcome) => outcome.status === "failed")) {
    process.exitCode = 1;
  }

  return flags.json
    ? JSON.stringify(response, null, 2)
    : renderSwitchToon(flags, response);
}

type DecisionError = {
  generatedAt: string;
  ok: false;
  issues: ReturnType<typeof validate>["issues"];
};

function resolveDecision(
  flags: SwitchFlags,
  now: string,
  tripwireStore: TripwireStore,
): { decision: DecisionResponse } | { error: DecisionError } {
  // A pre-computed decision file is honored as-is: `decide` already ran, so no
  // internal decide (and no tripwire fold-in) happens here.
  if (flags.decisionPath !== undefined) {
    return { decision: readDecisionFile(flags.decisionPath) };
  }

  // Re-run decide internally from registry + policy + observations, folding the
  // recorded tripwires into the observations so a tripped account stays out.
  const validation = validate(
    readYamlFile(flags.registryPath),
    readYamlFile(flags.policyPath),
  );
  if (!validation.valid || !validation.registry || !validation.policy) {
    return {
      error: { generatedAt: now, ok: false, issues: validation.issues },
    };
  }

  const observations = readObservations(flags.observationsPath as string);
  const tripwires = tripwireStore.read();
  const merged = foldTripwires(observations.observations, tripwires);

  const request: DecideRequest = {
    registry: validation.registry,
    policy: validation.policy,
    observations: merged,
    now: observations.now ?? now,
    ...(observations.sessions ? { sessions: observations.sessions } : {}),
    ...(observations.harness ? { harness: observations.harness } : {}),
    ...(observations.provider ? { provider: observations.provider } : {}),
  };
  return { decision: decide(request) };
}

/**
 * Fold recorded tripwire deadlines into the observations the internal decide
 * sees. A recorded `exhaustedUntil` is applied to the matching account unless
 * the observations already carry a later deadline, so the durable store and any
 * inline observation both keep an exhausted account out.
 */
function foldTripwires(
  observations: Record<string, AccountObservation>,
  tripwires: Record<string, { exhaustedUntil: string }>,
): Record<string, AccountObservation> {
  const merged: Record<string, AccountObservation> = {};
  for (const [account, observation] of Object.entries(observations)) {
    merged[account] = { ...observation };
  }
  for (const [account, tripwire] of Object.entries(tripwires)) {
    const existing = merged[account];
    if (!existing) {
      merged[account] = {
        windows: {},
        exhaustedUntil: tripwire.exhaustedUntil,
      };
      continue;
    }
    if (
      existing.exhaustedUntil === undefined ||
      Date.parse(tripwire.exhaustedUntil) > Date.parse(existing.exhaustedUntil)
    ) {
      merged[account] = {
        ...existing,
        exhaustedUntil: tripwire.exhaustedUntil,
      };
    }
  }
  return merged;
}

function readDecisionFile(path: string): DecisionResponse {
  const result = readJsonFileResult(path);
  if (result.status === "missing") {
    throw new AxiError(
      `decision file not found: ${collapseHome(path)}`,
      "VALIDATION_ERROR",
    );
  }
  if (result.status === "invalid") {
    throw new AxiError(
      `decision file could not be parsed (${result.error})`,
      "VALIDATION_ERROR",
    );
  }
  const value = result.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AxiError(
      "decision file must be a JSON object shaped like a decide response",
      "VALIDATION_ERROR",
    );
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.decisions)) {
    throw new AxiError(
      "decision file must contain a `decisions` array",
      "VALIDATION_ERROR",
    );
  }
  return value as DecisionResponse;
}

/** The observations file shape (identical to what `decide` accepts). */
type ObservationsFile = {
  now?: string;
  harness?: string;
  provider?: string;
  sessions?: SessionInput[];
  observations: Record<string, AccountObservation>;
};

function readObservations(path: string): ObservationsFile {
  const result = readJsonFileResult(path);
  if (result.status === "missing") {
    throw new AxiError(
      `observations file not found: ${collapseHome(path)}`,
      "VALIDATION_ERROR",
    );
  }
  if (result.status === "invalid") {
    throw new AxiError(
      `observations file could not be parsed (${result.error})`,
      "VALIDATION_ERROR",
    );
  }
  const value = result.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AxiError(
      "observations file must be a JSON object with an `observations` map",
      "VALIDATION_ERROR",
    );
  }
  const record = value as Record<string, unknown>;
  const observations = record.observations;
  if (
    observations === null ||
    typeof observations !== "object" ||
    Array.isArray(observations)
  ) {
    throw new AxiError(
      "observations file must contain an `observations` object keyed by account id",
      "VALIDATION_ERROR",
    );
  }
  const file: ObservationsFile = {
    observations: observations as Record<string, AccountObservation>,
  };
  if (typeof record.now === "string") file.now = record.now;
  if (typeof record.harness === "string") file.harness = record.harness;
  if (typeof record.provider === "string") file.provider = record.provider;
  if (Array.isArray(record.sessions)) {
    file.sessions = record.sessions as SessionInput[];
  }
  return file;
}

function renderSwitchToon(
  flags: SwitchFlags,
  response: SwitchResponse,
): string {
  const summary = encode({
    registry: collapseHome(flags.registryPath),
    policy: collapseHome(flags.policyPath),
    schemaVersion: response.schemaVersion,
    provider: response.provider,
    harness: response.harness,
    dryRun: response.dryRun,
    scopes: response.outcomes.length,
  });
  const rows = response.outcomes.map((outcome) => ({
    scope: outcome.scope,
    action: outcome.action,
    current: outcome.currentAccount ?? "(none)",
    chosen: outcome.chosenAccount ?? "(none)",
    status: outcome.status,
    actuation: outcome.claudeActuation
      ? `cswap:${outcome.claudeActuation.result}`
      : "",
    tripwire: outcome.recordedTripwire
      ? `${outcome.recordedTripwire.account}@${outcome.recordedTripwire.exhaustedUntil}`
      : "(none)",
    error: outcome.error ?? "",
  }));
  return `${summary}\n${encode({ outcomes: rows })}`;
}

function renderErrorToon(error: DecisionError): string {
  const summary = encode({ ok: false, issueCount: error.issues.length });
  const rows = error.issues.map((item) => ({
    file: item.file,
    path: item.path === "" ? "(root)" : item.path,
    code: item.code,
    message: item.message,
  }));
  return `${summary}\n${encode({ issues: rows })}`;
}

const VALUE_FLAGS = new Set([
  "--registry",
  "--policy",
  "--observations",
  "--decision",
  "--tripwires",
  "--jcode-binary",
  "--cswap-binary",
  "--recover-after-seconds",
]);

function matchValueFlag(arg: string): string | undefined {
  return VALUE_FLAGS.has(arg) ? arg : undefined;
}

function matchInline(arg: string): { flag: string; value: string } | undefined {
  const eq = arg.indexOf("=");
  if (eq < 0) return undefined;
  const flag = arg.slice(0, eq);
  if (!VALUE_FLAGS.has(flag)) return undefined;
  return { flag, value: arg.slice(eq + 1) };
}

function parseRecoverAfter(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new AxiError(
      `--recover-after-seconds must be a non-negative number, got ${value}`,
      "VALIDATION_ERROR",
    );
  }
  return seconds;
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

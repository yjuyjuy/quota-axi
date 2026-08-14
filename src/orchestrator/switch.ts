import type { DecisionResponse, SessionDecision } from "./decide.js";
import type {
  JcodeSessionSurface,
  SwitchAccountRequest,
  SwitchApplication,
} from "./jcode-surface.js";
import type { TripwireRecord } from "./tripwire-store.js";

/**
 * The pure actuation core of the `switch` verb (ADR 0031, Phase 1).
 *
 * `switch` is the ONE mutation verb in the whole orchestrator and the ONLY
 * writer. This module turns a versioned {@link DecisionResponse} (produced by
 * the pure `decide`) into two side effects, and reports exactly what it did:
 *
 *   1. It drives the jcode live-session control surface to move each session
 *      whose decision `action` is `switch` onto its `chosenAccount`. The
 *      `all-sessions` scope maps to a single `--all` switch; a session-id scope
 *      maps to a per-session switch. It relies on the surface's drain semantics
 *      and never forces a turn in flight.
 *   2. It records a tripwire ("account exhausted until T") for a current account
 *      the decision rotated off because that account was exhausted, so a later
 *      `decide` keeps it out until its recovery deadline.
 *
 * Phase 1 is account-only: it never sets the surface `model`, so rotation within
 * the Claude pool never changes the model. The model-map hook is preserved in
 * the surface shape for Phase 2.
 *
 * Failure isolation is a hard requirement: a failed per-scope actuation is
 * reported on that scope and never aborts the other scopes' switches. The core
 * is otherwise free of I/O detail: the jcode surface and the tripwire recorder
 * are injected, so it is exhaustively testable with fakes and a `dryRun` flag
 * short-circuits both side effects for a safe preview.
 */

/** Current switch-result schema version. Downstream callers (firstmate) pin. */
export const SWITCH_SCHEMA_VERSION = 1;

/** What `switch` did for one decision scope. */
export type ScopeOutcome = {
  /** The decision scope: a session id, or `all-sessions`. */
  scope: string;
  /** The decision action that drove this outcome. */
  action: SessionDecision["action"];
  /** The account the scope ran on before the switch, if any. */
  currentAccount?: string;
  /** The account the scope was moved onto; absent for keep/hold. */
  chosenAccount?: string;
  /**
   * The actuation outcome:
   *   - `applied`: the jcode surface applied the move immediately.
   *   - `deferred`: the move was deferred to the session's next turn (drain).
   *   - `skipped`: no switch was needed (a `keep` or `hold` decision).
   *   - `failed`: the actuation failed; see `error`.
   *   - `dry-run`: a switch that would have been issued but was previewed only.
   */
  status: "applied" | "deferred" | "skipped" | "failed" | "dry-run";
  /** The failure reason, present only when `status` is `failed`. */
  error?: string;
  /** The tripwire recorded for the rotated-off current account, if any. */
  recordedTripwire?: { account: string; exhaustedUntil: string };
};

/** The versioned result document `switch` emits. */
export type SwitchResponse = {
  schemaVersion: typeof SWITCH_SCHEMA_VERSION;
  generatedAt: string;
  provider: string;
  harness: string;
  /** True when this run issued no jcode calls and wrote no tripwire state. */
  dryRun: boolean;
  outcomes: ScopeOutcome[];
};

/** The reason codes on a decision that mean the current account is exhausted. */
const EXHAUSTION_REASON_CODES = new Set([
  "current_reserve_crossed",
  "current_tripwire_exhausted",
  "current_priming_gated",
]);

export type RunSwitchOptions = {
  /** The decision to actuate. */
  decision: DecisionResponse;
  /** The jcode live-session surface (real adapter or a test fake). */
  surface: JcodeSessionSurface;
  /**
   * Record tripwires for the given accounts. Injected so the core performs no
   * disk I/O itself; the command layer wires this to {@link TripwireStore}.
   * Not called at all in a dry run.
   */
  recordTripwires: (updates: Record<string, TripwireRecord>) => void;
  /** The actuation clock (ISO). Tripwire recovery is measured from it. */
  now: string;
  /**
   * How long a recorded tripwire holds a rotated-off account out, in seconds.
   * Observation-driven policy would set this; Phase 1 takes it as a parameter.
   */
  recoverAfterSeconds: number;
  /** Preview only: resolve the plan, issue no jcode calls, write no tripwires. */
  dryRun?: boolean;
};

/**
 * Actuate a decision. Never throws for a per-scope actuation failure: the
 * failure is captured on that scope's outcome and the remaining scopes still
 * run. Returns the versioned result document.
 */
export async function runSwitch(
  options: RunSwitchOptions,
): Promise<SwitchResponse> {
  const { decision, surface, now, recoverAfterSeconds } = options;
  const dryRun = options.dryRun ?? false;

  const outcomes: ScopeOutcome[] = [];
  const pendingTripwires: Record<string, TripwireRecord> = {};

  for (const item of decision.decisions) {
    const outcome = await actuateScope(item, surface, dryRun);

    // Record a tripwire on a current account the decision rotated off because
    // it was exhausted, so a later decide keeps it out until recovery. Only for
    // a real (non-dry) switch that actually left the exhausted account.
    if (
      item.action === "switch" &&
      item.currentAccount &&
      decisionLeftExhaustedAccount(item)
    ) {
      const exhaustedUntil = new Date(
        Date.parse(now) + recoverAfterSeconds * 1000,
      ).toISOString();
      outcome.recordedTripwire = {
        account: item.currentAccount,
        exhaustedUntil,
      };
      if (!dryRun) {
        pendingTripwires[item.currentAccount] = {
          exhaustedUntil,
          recordedAt: now,
          reason: exhaustionReasonCode(item) ?? "switched_off_exhausted",
        };
      }
    }

    outcomes.push(outcome);
  }

  if (!dryRun && Object.keys(pendingTripwires).length > 0) {
    options.recordTripwires(pendingTripwires);
  }

  return {
    schemaVersion: SWITCH_SCHEMA_VERSION,
    generatedAt: now,
    provider: decision.provider,
    harness: decision.harness,
    dryRun,
    outcomes,
  };
}

async function actuateScope(
  item: SessionDecision,
  surface: JcodeSessionSurface,
  dryRun: boolean,
): Promise<ScopeOutcome> {
  const base: ScopeOutcome = {
    scope: item.scope,
    action: item.action,
    status: "skipped",
  };
  if (item.currentAccount !== undefined)
    base.currentAccount = item.currentAccount;
  if (item.chosenAccount !== undefined) base.chosenAccount = item.chosenAccount;

  // A keep or hold decision issues no switch.
  if (item.action !== "switch") return base;

  // A switch decision without a chosen account is malformed; report it rather
  // than issuing a switch to nothing.
  if (item.chosenAccount === undefined) {
    return {
      ...base,
      status: "failed",
      error: "switch decision has no chosenAccount",
    };
  }

  if (dryRun) return { ...base, status: "dry-run" };

  const request = buildRequest(item.scope, item.chosenAccount);
  try {
    const result = await surface.switchAccount(request);
    return {
      ...base,
      status: result.application === "deferred" ? "deferred" : "applied",
    };
  } catch (error) {
    return { ...base, status: "failed", error: describeError(error) };
  }
}

/**
 * Map a decision scope onto a jcode switch request. The `all-sessions` scope
 * becomes an `--all` switch; any other scope is a per-session switch. Phase 1
 * is account-only, so `model` is never set.
 */
export function buildRequest(
  scope: string,
  account: string,
): SwitchAccountRequest {
  if (scope === "all-sessions") return { account, all: true };
  return { account, session: scope };
}

/** Whether this decision's reason chain shows it rotated off an exhausted account. */
function decisionLeftExhaustedAccount(item: SessionDecision): boolean {
  return item.reasons.some((reason) =>
    EXHAUSTION_REASON_CODES.has(reason.code),
  );
}

function exhaustionReasonCode(item: SessionDecision): string | undefined {
  return item.reasons.find((reason) => EXHAUSTION_REASON_CODES.has(reason.code))
    ?.code;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Re-exported for callers building surfaces around the drain contract. */
export type { SwitchApplication };

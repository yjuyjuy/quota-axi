import type { ClaudeHarnessSurface } from "./claude-surface.js";
import type { DecisionResponse, SessionDecision } from "./decide.js";
import type {
  JcodeSessionSurface,
  SessionSwitchOutcome,
  SwitchAccountRequest,
  SwitchAccountResult,
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

/**
 * The harness id whose binding is global and whose credential store is owned by
 * claude-swap (cswap). A decision for this harness is actuated by ONE atomic
 * cswap flip that re-points every live Claude session, never per-session.
 */
export const CLAUDE_HARNESS = "claude";

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
   * The actuation outcome, folded across every per-session outcome jcode
   * reported for this scope:
   *   - `applied`: every reported session applied the move immediately.
   *   - `deferred`: at least one session was deferred to its next turn (drain),
   *     and none failed.
   *   - `skipped`: no switch was needed (a `keep` or `hold` decision).
   *   - `failed`: the surface call threw, or at least one session reported
   *     `ok: false`; see `error`.
   *   - `dry-run`: a switch that would have been issued but was previewed only.
   */
  status: "applied" | "deferred" | "skipped" | "failed" | "dry-run";
  /** The failure reason, present only when `status` is `failed`. */
  error?: string;
  /**
   * The raw per-session outcomes jcode reported for this scope, preserved so a
   * caller sees exactly what the surface said (which session failed, which
   * deferred). Absent for skipped/dry-run scopes, the claude harness, and when
   * the surface threw.
   */
  sessionOutcomes?: SessionSwitchOutcome[];
  /**
   * How a claude-harness scope was actuated: the cswap target and whether it
   * was a fresh flip or already active. Present only for claude-harness scopes.
   */
  claudeActuation?: {
    target: string;
    result: "applied" | "already-active";
  };
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
  /**
   * The jcode live-session surface (real adapter or a test fake). Required when
   * the decision harness is jcode; unused for the claude harness.
   */
  surface?: JcodeSessionSurface;
  /**
   * The claude-harness surface: a cswap-backed adapter (or a test fake) that
   * drives one atomic global account flip. Required when the decision harness is
   * `claude`; a missing surface makes a claude switch fail closed.
   */
  claudeSurface?: ClaudeHarnessSurface;
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
  const { decision, now, recoverAfterSeconds } = options;
  const dryRun = options.dryRun ?? false;
  const isClaude = decision.harness === CLAUDE_HARNESS;

  const outcomes: ScopeOutcome[] = [];
  const pendingTripwires: Record<string, TripwireRecord> = {};

  // The claude harness binding is GLOBAL: one cswap flip re-points every live
  // Claude session. Multiple switch scopes onto the same account must therefore
  // collapse to ONE atomic flip, not one flip per scope. This memoizes the flip
  // per target so the second scope reuses the first's outcome.
  const claudeFlips = new Map<string, Promise<ScopeOutcome>>();

  for (const item of decision.decisions) {
    const outcome = isClaude
      ? await actuateClaudeScope(
          item,
          options.claudeSurface,
          dryRun,
          claudeFlips,
        )
      : await actuateScope(item, options.surface, dryRun);

    // Record a tripwire on a current account the decision rotated off because
    // it was exhausted, so a later decide keeps it out until recovery. Only for
    // a real (non-dry) switch that actually left the exhausted account, and only
    // when the actuation did not fail (a failed switch never rotated off, so
    // recording a tripwire would wrongly quarantine a still-current account).
    if (
      item.action === "switch" &&
      item.currentAccount &&
      outcome.status !== "failed" &&
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
  surface: JcodeSessionSurface | undefined,
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

  // Fail closed when the jcode surface is missing rather than silently skipping.
  if (surface === undefined) {
    return {
      ...base,
      status: "failed",
      error: "no jcode surface available to actuate the switch",
    };
  }

  const request = buildRequest(item.scope, item.chosenAccount);
  try {
    const result = await surface.switchAccount(request);
    return foldSurfaceResult(base, result);
  } catch (error) {
    return { ...base, status: "failed", error: describeError(error) };
  }
}

/**
 * Actuate one decision scope on the claude harness. The binding is global, so a
 * switch is a single atomic cswap flip onto `chosenAccount`; a second scope
 * targeting the same account reuses the same in-flight flip (memoized in
 * `flips`). A missing claude surface (cswap unavailable) fails closed with an
 * actionable message rather than a partial or silent switch.
 */
async function actuateClaudeScope(
  item: SessionDecision,
  surface: ClaudeHarnessSurface | undefined,
  dryRun: boolean,
  flips: Map<string, Promise<ScopeOutcome>>,
): Promise<ScopeOutcome> {
  const base: ScopeOutcome = {
    scope: item.scope,
    action: item.action,
    status: "skipped",
  };
  if (item.currentAccount !== undefined)
    base.currentAccount = item.currentAccount;
  if (item.chosenAccount !== undefined) base.chosenAccount = item.chosenAccount;

  if (item.action !== "switch") return base;

  if (item.chosenAccount === undefined) {
    return {
      ...base,
      status: "failed",
      error: "switch decision has no chosenAccount",
    };
  }

  if (dryRun) return { ...base, status: "dry-run" };

  const target = item.chosenAccount;
  // Reuse the atomic global flip for this target if a prior scope already asked
  // for it: cswap flips every live session at once, so a second call would be a
  // redundant no-op. The memoized promise carries the same base fields because
  // the outcome differs only in `scope`.
  let flip = flips.get(target);
  if (flip === undefined) {
    flip = performClaudeFlip(surface, target);
    flips.set(target, flip);
  }
  const flipped = await flip;
  return { ...flipped, scope: item.scope };
}

async function performClaudeFlip(
  surface: ClaudeHarnessSurface | undefined,
  target: string,
): Promise<ScopeOutcome> {
  const base: ScopeOutcome = {
    scope: "all-sessions",
    action: "switch",
    chosenAccount: target,
    status: "skipped",
  };
  // Fail closed: with no cswap-backed surface there is exactly one safe outcome,
  // a clear refusal, never a partial switch.
  if (surface === undefined) {
    return {
      ...base,
      status: "failed",
      error:
        "cswap is unavailable, so the Claude harness cannot be switched; " +
        "install claude-swap (cswap) or point --cswap-binary at it",
    };
  }
  let outcome: Awaited<ReturnType<ClaudeHarnessSurface["switchAccount"]>>;
  try {
    outcome = await surface.switchAccount(target);
  } catch (error) {
    return { ...base, status: "failed", error: describeError(error) };
  }
  switch (outcome.status) {
    case "applied":
      return {
        ...base,
        status: "applied",
        claudeActuation: { target, result: "applied" },
      };
    case "already-active":
      return {
        ...base,
        status: "applied",
        claudeActuation: { target, result: "already-active" },
      };
    case "unavailable":
      return { ...base, status: "failed", error: outcome.error };
    case "failed":
      return { ...base, status: "failed", error: outcome.error };
  }
}

/**
 * Fold jcode's per-session outcomes into one scope outcome. Any session that
 * reported `ok: false` fails the scope (carrying that session's error); with no
 * failure, a deferred session makes the scope `deferred`, otherwise `applied`.
 * An empty outcome array (jcode matched no live session) is a failure rather
 * than a false `applied`, so a no-op switch is never reported as success. The
 * raw per-session outcomes are preserved on the scope outcome.
 */
function foldSurfaceResult(
  base: ScopeOutcome,
  result: SwitchAccountResult,
): ScopeOutcome {
  const outcomes = result.outcomes;
  const withOutcomes: ScopeOutcome =
    outcomes.length > 0 ? { ...base, sessionOutcomes: outcomes } : { ...base };

  if (outcomes.length === 0) {
    return {
      ...withOutcomes,
      status: "failed",
      error: "jcode reported no session outcomes for the switch",
    };
  }

  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length > 0) {
    return {
      ...withOutcomes,
      status: "failed",
      error: describeSessionFailures(failed),
    };
  }

  const deferred = outcomes.some((outcome) => outcome.deferred);
  return { ...withOutcomes, status: deferred ? "deferred" : "applied" };
}

function describeSessionFailures(failed: SessionSwitchOutcome[]): string {
  return failed
    .map((outcome) => {
      const id = outcome.sessionId || "(unknown)";
      return outcome.error ? `${id}: ${outcome.error}` : `${id}: failed`;
    })
    .join("; ");
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

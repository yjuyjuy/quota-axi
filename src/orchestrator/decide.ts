/**
 * The pure account-switch decider (ADR 0031, Phase 1).
 *
 * `decide` is the brain of the fleet account orchestrator, and it is a PURE
 * function: registry + policy + observed per-account window telemetry go in, a
 * versioned decision naming the chosen account (and the reason chain that led
 * there) comes out. It has ZERO side effects. It reads no files, writes no
 * store, and never routes, switches, spends, or mutates provider state. The
 * mutating actuation is the separate later `switch` verb; keeping `decide` pure
 * is the fence that keeps quota-axi safe and makes strategies testable offline
 * with fixtures.
 *
 * Phase 1 scope (STRICT): one harness (jcode), one provider (Claude), mixed
 * plan accounts. Rotation within the Claude pool never changes the model, there
 * are no cross-provider moves, and there is no model mapping. The precedence and
 * the model-map hook are preserved in the shape (see {@link DecideRequest} and
 * the `provider`/`harness` fields) for Phase 2, but no cross-provider or
 * model-map behavior is built here.
 */

import type {
  AccountRegistry,
  Policy,
  PolicyPrimingGate,
  RegistryAccount,
  WindowReserveFloors,
} from "./types.js";

/**
 * Current decision schema version. Downstream callers (firstmate
 * dispatch-select, the watcher) pin to this, so bump it only on a breaking
 * change to {@link DecisionResponse}.
 */
export const DECISION_SCHEMA_VERSION = 1;

/** Phase 1 fixes both of these; they are inputs so Phase 2 can widen them. */
export const DEFAULT_HARNESS = "jcode";
export const DEFAULT_PROVIDER = "claude";

/**
 * One account's observed telemetry, as the decider consumes it. This is the
 * pure, provider-agnostic projection of a live quota observation: per-window
 * remaining percent plus a freshness verdict and any recorded tripwire. The CLI
 * layer builds these from live {@link ProviderQuota} snapshots read through the
 * shared usage cache; the pure core never fetches anything itself.
 */
export type AccountObservation = {
  /** Observed remaining percent (0-100) keyed by quota window id. */
  windows: Record<string, number>;
  /**
   * Whether this telemetry is trustworthy. `unknown` (or a missing observation
   * entirely) means missing or stale data: the account is UNKNOWN, usable only
   * when no known-good account remains, and never a reason to switch away from a
   * working account. Defaults to `known` when the field is omitted but the
   * observation is present.
   */
  freshness?: "known" | "unknown";
  /**
   * A recorded tripwire: the account is treated as exhausted until this ISO
   * time. This is durable state the later `switch` actuation records; the pure
   * decider only reads it. A tripwire in the future forces the account out of
   * selection regardless of telemetry freshness.
   */
  exhaustedUntil?: string;
};

/** One session the decision is being made for. */
export type SessionInput = {
  /** Session id; becomes the decision `scope`. */
  id: string;
  /** The account this session runs on now, if any. */
  currentAccount?: string;
};

/** The complete, pure input to {@link decide}. No I/O is performed on it. */
export type DecideRequest = {
  registry: AccountRegistry;
  policy: Policy;
  /** Observed telemetry keyed by registry account id. */
  observations: Record<string, AccountObservation>;
  /** The decision clock (ISO). Tripwire recovery is measured against this. */
  now: string;
  /**
   * Sessions to decide for. When omitted, a single `all-sessions` decision is
   * produced. This is the per-session hook: Phase 1 keeps it optional.
   */
  sessions?: SessionInput[];
  /** Harness id sessions run on. Phase 1 default {@link DEFAULT_HARNESS}. */
  harness?: string;
  /** Provider the pool serves. Phase 1 default {@link DEFAULT_PROVIDER}. */
  provider?: string;
};

/** Where a reserve floor came from, so the reason chain is auditable. */
export type ReserveFloorSource = "pool" | "policy_captain" | "account_captain";

/**
 * One structured step in a decision's reason chain. Codes are stable machine
 * strings so downstream consumers can branch on them; `detail` carries the
 * evidence (which window, which floor, which threshold) behind the step.
 */
export type DecisionReason = {
  code: DecisionReasonCode;
  /** The account this step is about, when it concerns a specific account. */
  account?: string;
  /** Structured evidence for the step. */
  detail?: Record<string, unknown>;
};

export type DecisionReasonCode =
  // Leading summary of the current account's state.
  | "current_available"
  | "current_unknown_telemetry"
  | "current_reserve_crossed"
  | "current_tripwire_exhausted"
  | "current_priming_gated"
  | "current_ineligible"
  | "no_current_account"
  // Why a more-preferred candidate was skipped on the way to the choice.
  | "skipped_ineligible"
  | "skipped_reserve_crossed"
  | "skipped_tripwire_exhausted"
  | "skipped_priming_gated"
  | "skipped_unknown_telemetry"
  // The outcome.
  | "kept_current_available"
  | "kept_current_unknown_telemetry"
  | "selected_available"
  | "selected_unknown_fallback"
  | "hold_all_exhausted";

/** What the decider concluded for one session. */
export type SessionDecision = {
  /** The session id, or `all-sessions` when no sessions were supplied. */
  scope: string;
  /** `keep` stays put, `switch` moves, `hold` runs nothing (all exhausted). */
  action: "keep" | "switch" | "hold";
  /** The account this session runs on now, if any. */
  currentAccount?: string;
  /** The chosen account; absent only for `hold`. */
  chosenAccount?: string;
  /** The ordered reason chain that produced this decision. */
  reasons: DecisionReason[];
};

/** The versioned decision document downstream callers pin to. */
export type DecisionResponse = {
  schemaVersion: typeof DECISION_SCHEMA_VERSION;
  generatedAt: string;
  provider: string;
  harness: string;
  decisions: SessionDecision[];
};

/**
 * A candidate account, resolved to its registry record and its policy position,
 * in fixed-cost-first precedence order.
 */
type Candidate = {
  account: RegistryAccount;
  tierName: string;
  tierIndex: number;
  poolIndex: number;
  /** Combined reserve floors (max per window) from pool + policy + account. */
  floors: FloorSpec[];
  /** Priming gates that apply to this account. */
  gates: PolicyPrimingGate[];
};

type FloorSpec = {
  window: string;
  percent: number;
  source: ReserveFloorSource;
};

/** How a candidate evaluates against the observed telemetry right now. */
type Evaluation =
  | { status: "available" }
  | { status: "ineligible"; reason: string }
  | {
      status: "reserve_crossed";
      window: string;
      floor: number;
      remaining: number;
      source: ReserveFloorSource;
    }
  | { status: "tripwire_exhausted"; until: string }
  | {
      status: "priming_gated";
      window: string;
      threshold: number;
      remaining: number;
    }
  | { status: "unknown_telemetry" };

/**
 * Decide, purely, which account each session should run on. Never mutates its
 * input and never performs I/O.
 */
export function decide(request: DecideRequest): DecisionResponse {
  const harness = request.harness ?? DEFAULT_HARNESS;
  const provider = request.provider ?? DEFAULT_PROVIDER;
  const nowMs = Date.parse(request.now);

  const candidates = buildCandidates(request.policy, request.registry, {
    harness,
    provider,
  });

  const sessions: SessionInput[] =
    request.sessions && request.sessions.length > 0
      ? request.sessions
      : [{ id: "all-sessions" }];

  const decisions = sessions.map((session) =>
    decideSession(session, candidates, request, nowMs),
  );

  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    generatedAt: request.now,
    provider,
    harness,
    decisions,
  };
}

function decideSession(
  session: SessionInput,
  candidates: Candidate[],
  request: DecideRequest,
  nowMs: number,
): SessionDecision {
  const reasons: DecisionReason[] = [];
  const evaluate = (candidate: Candidate): Evaluation =>
    evaluateCandidate(candidate, request.observations, nowMs);

  // 1. Summarize the current account's state, and decide whether it forces a
  //    move. A tripwire, a crossed reserve floor, or a priming gate on the
  //    current account is a definitive reason to switch. Unknown telemetry on
  //    the current account is NEVER a reason to switch away from it.
  const currentAccount = session.currentAccount;
  const currentCandidate = currentAccount
    ? candidates.find((item) => item.account.id === currentAccount)
    : undefined;

  if (!currentAccount) {
    reasons.push({ code: "no_current_account" });
  } else if (!currentCandidate) {
    // The current account is not an eligible candidate (wrong harness/provider,
    // or absent from the policy). Treat it as forcing a move.
    reasons.push({
      code: "current_ineligible",
      account: currentAccount,
      detail: { reason: "not_an_eligible_candidate" },
    });
  } else {
    const currentEval = evaluate(currentCandidate);
    const forced = summarizeCurrent(currentAccount, currentEval, reasons);
    if (!forced) {
      // The current account still works (available) or is merely unknown: keep
      // it unless a strictly more-preferred account is available.
      return keepOrReturnToPreferred(
        session,
        currentCandidate,
        currentEval,
        candidates,
        evaluate,
        reasons,
      );
    }
  }

  // 2. The session must move (no current account, current ineligible, or the
  //    current account is definitively exhausted). Choose the first available
  //    candidate in precedence order; fall back to an unknown candidate only
  //    when no known-good account remains; otherwise hold.
  return selectFresh(session, candidates, evaluate, reasons);
}

/**
 * Push the leading `current_*` reason and report whether the current account's
 * state forces a switch. Unknown telemetry does not force a switch.
 */
function summarizeCurrent(
  account: string,
  evaluation: Evaluation,
  reasons: DecisionReason[],
): boolean {
  switch (evaluation.status) {
    case "available":
      reasons.push({ code: "current_available", account });
      return false;
    case "unknown_telemetry":
      reasons.push({ code: "current_unknown_telemetry", account });
      return false;
    case "reserve_crossed":
      reasons.push({
        code: "current_reserve_crossed",
        account,
        detail: {
          window: evaluation.window,
          floor: evaluation.floor,
          remaining: evaluation.remaining,
          source: evaluation.source,
        },
      });
      return true;
    case "tripwire_exhausted":
      reasons.push({
        code: "current_tripwire_exhausted",
        account,
        detail: { until: evaluation.until },
      });
      return true;
    case "priming_gated":
      reasons.push({
        code: "current_priming_gated",
        account,
        detail: {
          window: evaluation.window,
          threshold: evaluation.threshold,
          remaining: evaluation.remaining,
        },
      });
      return true;
    case "ineligible":
      reasons.push({
        code: "current_ineligible",
        account,
        detail: { reason: evaluation.reason },
      });
      return true;
  }
}

/**
 * The current account is available or unknown. Keep it, unless it is available
 * and a strictly more-preferred account is also available (return from a
 * fallback tier, or honor fixed-cost-first cost preference). Unknown current
 * telemetry always keeps the current account.
 */
function keepOrReturnToPreferred(
  session: SessionInput,
  currentCandidate: Candidate,
  currentEval: Evaluation,
  candidates: Candidate[],
  evaluate: (candidate: Candidate) => Evaluation,
  reasons: DecisionReason[],
): SessionDecision {
  const currentRank = candidates.indexOf(currentCandidate);

  if (currentEval.status === "unknown_telemetry") {
    reasons.push({
      code: "kept_current_unknown_telemetry",
      account: currentCandidate.account.id,
    });
    return keep(session, currentCandidate.account.id, reasons);
  }

  // Look for a strictly more-preferred available account.
  for (let index = 0; index < currentRank; index++) {
    const candidate = candidates[index];
    const evaluation = evaluate(candidate);
    if (evaluation.status === "available") {
      pushSelected(candidate, "selected_available", reasons);
      return switchTo(session, candidate.account.id, reasons);
    }
    pushSkip(candidate, evaluation, reasons);
  }

  reasons.push({
    code: "kept_current_available",
    account: currentCandidate.account.id,
  });
  return keep(session, currentCandidate.account.id, reasons);
}

/**
 * Select an account from scratch (no viable current account). First available
 * in precedence order wins; else the first unknown candidate; else hold.
 */
function selectFresh(
  session: SessionInput,
  candidates: Candidate[],
  evaluate: (candidate: Candidate) => Evaluation,
  reasons: DecisionReason[],
): SessionDecision {
  let firstUnknown: Candidate | undefined;
  const skippedBeforeUnknown: {
    candidate: Candidate;
    evaluation: Evaluation;
  }[] = [];

  for (const candidate of candidates) {
    const evaluation = evaluate(candidate);
    if (evaluation.status === "available") {
      // Flush any skips accumulated ahead of this available choice.
      for (const skipped of skippedBeforeUnknown) {
        pushSkip(skipped.candidate, skipped.evaluation, reasons);
      }
      pushSelected(candidate, "selected_available", reasons);
      return switchTo(session, candidate.account.id, reasons);
    }
    if (evaluation.status === "unknown_telemetry" && !firstUnknown) {
      firstUnknown = candidate;
    }
    skippedBeforeUnknown.push({ candidate, evaluation });
  }

  // No known-good account remains. Use an unknown candidate if one exists,
  // otherwise everything is exhausted: hold rather than loop.
  if (firstUnknown) {
    for (const skipped of skippedBeforeUnknown) {
      if (skipped.candidate === firstUnknown) break;
      pushSkip(skipped.candidate, skipped.evaluation, reasons);
    }
    pushSelected(firstUnknown, "selected_unknown_fallback", reasons);
    return switchTo(session, firstUnknown.account.id, reasons);
  }

  for (const skipped of skippedBeforeUnknown) {
    pushSkip(skipped.candidate, skipped.evaluation, reasons);
  }
  reasons.push({ code: "hold_all_exhausted" });
  return hold(session, reasons);
}

function pushSelected(
  candidate: Candidate,
  code: "selected_available" | "selected_unknown_fallback",
  reasons: DecisionReason[],
): void {
  reasons.push({
    code,
    account: candidate.account.id,
    detail: {
      tier: candidate.tierName,
      tierIndex: candidate.tierIndex,
      poolIndex: candidate.poolIndex,
      costClass: candidate.account.cost_class,
    },
  });
}

function pushSkip(
  candidate: Candidate,
  evaluation: Evaluation,
  reasons: DecisionReason[],
): void {
  const account = candidate.account.id;
  switch (evaluation.status) {
    case "available":
      return;
    case "ineligible":
      reasons.push({
        code: "skipped_ineligible",
        account,
        detail: { reason: evaluation.reason },
      });
      return;
    case "reserve_crossed":
      reasons.push({
        code: "skipped_reserve_crossed",
        account,
        detail: {
          window: evaluation.window,
          floor: evaluation.floor,
          remaining: evaluation.remaining,
          source: evaluation.source,
        },
      });
      return;
    case "tripwire_exhausted":
      reasons.push({
        code: "skipped_tripwire_exhausted",
        account,
        detail: { until: evaluation.until },
      });
      return;
    case "priming_gated":
      reasons.push({
        code: "skipped_priming_gated",
        account,
        detail: {
          window: evaluation.window,
          threshold: evaluation.threshold,
          remaining: evaluation.remaining,
        },
      });
      return;
    case "unknown_telemetry":
      reasons.push({ code: "skipped_unknown_telemetry", account });
      return;
  }
}

function keep(
  session: SessionInput,
  account: string,
  reasons: DecisionReason[],
): SessionDecision {
  return finalize(session, "keep", reasons, account);
}

function switchTo(
  session: SessionInput,
  account: string,
  reasons: DecisionReason[],
): SessionDecision {
  return finalize(session, "switch", reasons, account);
}

function hold(
  session: SessionInput,
  reasons: DecisionReason[],
): SessionDecision {
  return finalize(session, "hold", reasons, undefined);
}

function finalize(
  session: SessionInput,
  action: SessionDecision["action"],
  reasons: DecisionReason[],
  chosenAccount: string | undefined,
): SessionDecision {
  const decision: SessionDecision = { scope: session.id, action, reasons };
  if (session.currentAccount !== undefined) {
    decision.currentAccount = session.currentAccount;
  }
  if (chosenAccount !== undefined) decision.chosenAccount = chosenAccount;
  return decision;
}

/**
 * Evaluate one candidate against the observed telemetry. The order of checks is
 * significant: a recorded tripwire and eligibility are decided without
 * telemetry, then reserve floors and priming gates require known telemetry, and
 * missing or stale telemetry collapses to `unknown`.
 */
function evaluateCandidate(
  candidate: Candidate,
  observations: Record<string, AccountObservation>,
  nowMs: number,
): Evaluation {
  const observation = observations[candidate.account.id];

  // A recorded tripwire is durable, telemetry-independent state.
  if (observation?.exhaustedUntil) {
    const untilMs = Date.parse(observation.exhaustedUntil);
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      return {
        status: "tripwire_exhausted",
        until: observation.exhaustedUntil,
      };
    }
  }

  // Missing or explicitly stale telemetry: the account is UNKNOWN.
  if (!observation || observation.freshness === "unknown") {
    return { status: "unknown_telemetry" };
  }

  // Reserve floors: the account must keep at least `floor` percent unused in
  // every floored window. A window with no observation cannot be confirmed
  // safe, so it collapses the account to unknown rather than passing silently.
  for (const floor of candidate.floors) {
    const remaining = observation.windows[floor.window];
    if (remaining === undefined) return { status: "unknown_telemetry" };
    if (remaining <= floor.percent) {
      return {
        status: "reserve_crossed",
        window: floor.window,
        floor: floor.percent,
        remaining,
        source: floor.source,
      };
    }
  }

  // Priming gates: keep a cooled-down account out until the named window
  // recovers to its resume threshold. A gated window with no observation is
  // also unknown.
  for (const gate of candidate.gates) {
    const remaining = observation.windows[gate.window];
    if (remaining === undefined) return { status: "unknown_telemetry" };
    if (remaining < gate.resume_at_percent_remaining) {
      return {
        status: "priming_gated",
        window: gate.window,
        threshold: gate.resume_at_percent_remaining,
        remaining,
      };
    }
  }

  return { status: "available" };
}

/**
 * Build the ordered candidate list. Candidates come from the policy tiers/pools
 * in author order, restricted to accounts eligible for this harness and
 * provider, de-duplicated (first policy occurrence wins), and finally
 * stable-partitioned so every fixed-cost account precedes every metered account.
 *
 * The fixed-cost-first partition is the hard tier-fallback fence: a metered
 * (API-billed) account is only ever considered after every fixed-cost
 * subscription account, even if a captain mis-orders the policy tiers.
 */
function buildCandidates(
  policy: Policy,
  registry: AccountRegistry,
  filter: { harness: string; provider: string },
): Candidate[] {
  const byId = new Map(registry.accounts.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const ordered: Candidate[] = [];

  policy.tiers.forEach((tier, tierIndex) => {
    tier.pools.forEach((pool, poolIndex) => {
      for (const accountId of pool.accounts) {
        if (seen.has(accountId)) continue;
        const account = byId.get(accountId);
        if (!account) continue;
        if (account.provider !== filter.provider) continue;
        if (!account.harness_eligibility.includes(filter.harness)) continue;
        seen.add(accountId);
        ordered.push({
          account,
          tierName: tier.name,
          tierIndex,
          poolIndex,
          floors: combineFloors(
            pool.min_reserve,
            policy.captain_reserve,
            account,
          ),
          gates: primingGatesFor(policy.priming, accountId),
        });
      }
    });
  });

  const fixed = ordered.filter((item) => item.account.cost_class === "fixed");
  const metered = ordered.filter(
    (item) => item.account.cost_class === "metered",
  );
  return [...fixed, ...metered];
}

/**
 * Combine reserve floors from the pool, the policy-level captain reserve, and
 * the account-level captain reserve. When more than one source floors the same
 * window, the highest (most conservative) floor wins, and its source is
 * recorded so the reason chain can name what fired.
 */
function combineFloors(
  poolReserve: WindowReserveFloors | undefined,
  policyReserve: WindowReserveFloors | undefined,
  account: RegistryAccount,
): FloorSpec[] {
  const best = new Map<string, FloorSpec>();
  const consider = (
    reserve: WindowReserveFloors | undefined,
    source: ReserveFloorSource,
  ): void => {
    if (!reserve) return;
    for (const [window, percent] of Object.entries(reserve)) {
      const existing = best.get(window);
      if (!existing || percent > existing.percent) {
        best.set(window, { window, percent, source });
      }
    }
  };
  consider(poolReserve, "pool");
  consider(policyReserve, "policy_captain");
  consider(account.captain_reserve, "account_captain");
  return [...best.values()].sort((a, b) => a.window.localeCompare(b.window));
}

function primingGatesFor(
  priming: PolicyPrimingGate[] | undefined,
  accountId: string,
): PolicyPrimingGate[] {
  if (!priming) return [];
  return priming.filter(
    (gate) => gate.accounts === undefined || gate.accounts.includes(accountId),
  );
}

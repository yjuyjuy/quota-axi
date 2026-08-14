/**
 * The strategy-gated priming pass (ADR 0031, Phase 2).
 *
 * Priming keeps every FIXED-COST account primed: auth verified and telemetry
 * fresh within one window cycle. A flat-rate account that sits idle is wasted
 * capacity, and stale telemetry on it means the pure `decide` cannot trust its
 * state when routing. Priming closes that gap.
 *
 * Honest rationale (ADR 0031, critical): priming ONLY verifies auth and
 * freshens telemetry. It is NOT claimed to advance or reset any provider reset
 * clock, and this module builds no reset-clock-advancing behavior. Anthropic's
 * support-documented reset semantics do not support that claim.
 *
 * The pass is split into a pure planner and an injected-seam executor, mirroring
 * the `decide` (pure) / `switch` (actuation) fence:
 *
 *   - {@link planPriming} is a PURE function: registry + policy + per-account
 *     priming telemetry in, a plan naming what each fixed-cost account needs
 *     out. Zero side effects. It never fetches, never pings, never mutates.
 *   - {@link runPriming} consumes the plan and an injected {@link PrimingProber}
 *     (the ONLY side-effecting seam) to issue the minimal synthetic ping for the
 *     accounts the plan marks `prime-via-synthetic`. The prober is wired to the
 *     Phase 1 shared usage cache in the command layer, so priming adds NO second
 *     fetch path. `dryRun` issues no pings at all.
 *
 * Two hard gates protect the fence:
 *
 *   1. STRATEGY GATE. When `policy.priming_strategy` is absent or `enabled` is
 *      false, the plan contains ZERO synthetic actions and {@link runPriming}
 *      issues ZERO synthetic calls. This is the "priming OFF -> no synthetic
 *      traffic at all" acceptance invariant.
 *   2. REAL-WORK PREFERENCE. When real work is pending and `prefer_real_work` is
 *      on (the default), an account that needs priming is marked
 *      `prime-via-real-work`: routing real work to under-used fixed-cost
 *      accounts (the `decide` preference) freshens their telemetry, so a
 *      synthetic ping is the LAST resort, issued only when the fleet is idle.
 */

import type { AccountRegistry, Policy, RegistryAccount } from "./types.js";

/** Current priming-result schema version. Downstream callers pin to this. */
export const PRIMING_SCHEMA_VERSION = 1;

/**
 * Default staleness threshold and synthetic-ping cadence: the shortest window
 * cycle (five hours), so a fixed-cost account's telemetry never goes stale
 * relative to its fastest-moving quota window.
 */
export const DEFAULT_MAX_TELEMETRY_AGE_SECONDS = 5 * 60 * 60;

/**
 * One fixed-cost account's priming telemetry, as the planner consumes it. This
 * is the pure projection of a live quota observation: whether the telemetry is
 * trustworthy, whether auth is verified, and how old the telemetry is. The
 * command layer builds these from live provider snapshots read through the
 * shared usage cache; the pure planner never fetches anything itself.
 */
export type PrimingTelemetry = {
  /**
   * Whether the telemetry is trustworthy. `unknown` (or a missing entry) means
   * missing or stale data: the account needs priming.
   */
  freshness?: "known" | "unknown";
  /**
   * Whether the account's local credential is verified usable. `false` or
   * omitted means auth is unverified: the account needs priming.
   */
  authVerified?: boolean;
  /**
   * Age of the telemetry in seconds. Telemetry at or beyond the strategy's
   * `max_telemetry_age_seconds` is stale and triggers priming. Omitted counts
   * as unknown age, which also triggers priming.
   */
  ageSeconds?: number;
  /**
   * Observed remaining-percent (0-100) keyed by quota window id, used only for
   * the real-work routing preference (route real work to the account with the
   * most headroom first). Never used to decide whether an account needs
   * priming; that is `freshness`, `authVerified`, and `ageSeconds`.
   */
  windows?: Record<string, number>;
};

/** The complete, pure input to {@link planPriming}. No I/O is performed on it. */
export type PlanPrimingRequest = {
  registry: AccountRegistry;
  policy: Policy;
  /** Per-account priming telemetry keyed by registry account id. */
  telemetry: Record<string, PrimingTelemetry>;
  /**
   * Whether real work is pending for the fleet right now. When true and the
   * strategy prefers real work, an account that needs priming defers to
   * real-work routing (no synthetic ping); when false (idle), a synthetic ping
   * is the last resort. Defaults to false (idle) when omitted.
   */
  realWorkPending?: boolean;
  /** Provider the pool serves. Phase 1/2 default `claude`. */
  provider?: string;
};

/** Why an account was placed in its priming status, for an auditable report. */
export type PrimingReason =
  | "strategy_disabled"
  | "not_fixed_cost"
  | "already_primed"
  | "stale_telemetry"
  | "unknown_telemetry"
  | "auth_unverified"
  | "deferred_to_real_work";

/** What the planner concluded for one fixed-cost account. */
export type PrimingItem = {
  account: string;
  provider: string;
  /**
   *   - `primed`: fresh telemetry and verified auth; nothing to do.
   *   - `prime-via-real-work`: needs priming, but real work is pending and the
   *     strategy prefers real work, so routing (not a synthetic ping) handles
   *     it. No synthetic traffic.
   *   - `prime-via-synthetic`: needs priming, the fleet is idle, and the gate is
   *     on, so the executor issues the minimal synthetic ping.
   *   - `disabled`: the strategy gate is off; nothing to do, zero synthetic
   *     traffic.
   */
  status: "primed" | "prime-via-real-work" | "prime-via-synthetic" | "disabled";
  reasons: PrimingReason[];
};

/** The pure plan {@link planPriming} emits. */
export type PrimingPlan = {
  schemaVersion: typeof PRIMING_SCHEMA_VERSION;
  provider: string;
  /** Whether the strategy gate is on for this plan. */
  enabled: boolean;
  /** Whether the plan prefers routing real work over a synthetic ping. */
  preferRealWork: boolean;
  /** The staleness threshold and synthetic-ping cadence (seconds) in effect. */
  maxTelemetryAgeSeconds: number;
  /** One item per fixed-cost account, in registry order. */
  items: PrimingItem[];
};

/**
 * Plan, purely, what each fixed-cost account needs to stay primed. Never
 * mutates its input and never performs I/O. When the strategy gate is off,
 * every item is `disabled` and NO item is ever `prime-via-synthetic`, which is
 * the zero-synthetic-when-off invariant callers assert.
 */
export function planPriming(request: PlanPrimingRequest): PrimingPlan {
  const provider = request.provider ?? "claude";
  const strategy = request.policy.priming_strategy;
  const enabled = strategy?.enabled === true;
  const preferRealWork = strategy?.prefer_real_work !== false;
  const maxTelemetryAgeSeconds =
    strategy?.max_telemetry_age_seconds ?? DEFAULT_MAX_TELEMETRY_AGE_SECONDS;
  const realWorkPending = request.realWorkPending === true;

  const fixedCostAccounts = request.registry.accounts.filter(
    (account) =>
      account.cost_class === "fixed" && account.provider === provider,
  );

  const items = fixedCostAccounts.map((account) =>
    planAccount(account, provider, {
      enabled,
      preferRealWork,
      maxTelemetryAgeSeconds,
      realWorkPending,
      telemetry: request.telemetry[account.id],
    }),
  );

  return {
    schemaVersion: PRIMING_SCHEMA_VERSION,
    provider,
    enabled,
    preferRealWork,
    maxTelemetryAgeSeconds,
    items,
  };
}

function planAccount(
  account: RegistryAccount,
  provider: string,
  context: {
    enabled: boolean;
    preferRealWork: boolean;
    maxTelemetryAgeSeconds: number;
    realWorkPending: boolean;
    telemetry: PrimingTelemetry | undefined;
  },
): PrimingItem {
  // Gate off: nothing to do, and never a synthetic action.
  if (!context.enabled) {
    return {
      account: account.id,
      provider,
      status: "disabled",
      reasons: ["strategy_disabled"],
    };
  }

  const needs = primingNeeds(context.telemetry, context.maxTelemetryAgeSeconds);
  if (needs.length === 0) {
    return {
      account: account.id,
      provider,
      status: "primed",
      reasons: ["already_primed"],
    };
  }

  // Prefer real work: when work is pending and the strategy prefers it, routing
  // freshens telemetry, so no synthetic ping is issued.
  if (context.preferRealWork && context.realWorkPending) {
    return {
      account: account.id,
      provider,
      status: "prime-via-real-work",
      reasons: [...needs, "deferred_to_real_work"],
    };
  }

  // Idle fleet (or real-work preference off): the minimal synthetic ping is the
  // last resort that keeps the account primed.
  return {
    account: account.id,
    provider,
    status: "prime-via-synthetic",
    reasons: needs,
  };
}

/** The set of reasons this account needs priming, empty when fully primed. */
function primingNeeds(
  telemetry: PrimingTelemetry | undefined,
  maxTelemetryAgeSeconds: number,
): PrimingReason[] {
  const reasons: PrimingReason[] = [];
  if (!telemetry || telemetry.freshness === "unknown") {
    reasons.push("unknown_telemetry");
  } else if (
    telemetry.ageSeconds === undefined ||
    telemetry.ageSeconds >= maxTelemetryAgeSeconds
  ) {
    reasons.push("stale_telemetry");
  }
  if (!telemetry || telemetry.authVerified !== true) {
    reasons.push("auth_unverified");
  }
  return reasons;
}

// --- executor -------------------------------------------------------------

/**
 * The result of one synthetic ping. The prober both verifies auth and freshens
 * telemetry through the SAME shared usage cache read, so a successful ping means
 * the account is primed: auth verified and telemetry fresh.
 */
export type PrimeProbeResult = {
  ok: boolean;
  /** Whether the ping verified the account's auth. */
  authVerified: boolean;
  /** ISO timestamp of the freshened telemetry, when the ping succeeded. */
  fetchedAt?: string;
  /** Failure reason, present when `ok` is false. */
  error?: string;
};

/**
 * The ONE side-effecting seam of the priming pass. Given a fixed-cost account,
 * it issues the cheapest safe synthetic call for that account's provider - a
 * read-only usage read routed through the Phase 1 shared usage cache - and
 * reports whether auth verified and telemetry freshened. Unit tests replace it
 * with a fake that records calls; the command layer wires it to the real cache.
 *
 * The prober is the ONLY thing priming may do besides reading: it never mutates
 * a credential store, never records a tripwire, and never routes or switches.
 */
export type PrimingProber = (
  account: RegistryAccount,
) => Promise<PrimeProbeResult>;

/** What {@link runPriming} did for one account. */
export type PrimingOutcome = {
  account: string;
  provider: string;
  status: PrimingItem["status"];
  /**
   * The actuation outcome:
   *   - `primed`: a `primed` item; nothing was done.
   *   - `pinged`: a synthetic ping was issued and it verified auth + freshened
   *     telemetry.
   *   - `deferred-to-real-work`: a `prime-via-real-work` item; no synthetic ping.
   *   - `skipped-disabled`: the gate was off; no synthetic ping.
   *   - `dry-run`: a synthetic ping that would have been issued but was previewed.
   *   - `failed`: the synthetic ping was issued but failed; see `error`.
   */
  action:
    | "primed"
    | "pinged"
    | "deferred-to-real-work"
    | "skipped-disabled"
    | "dry-run"
    | "failed";
  /** Whether auth is verified after this pass, when the ping reported it. */
  authVerified?: boolean;
  /** ISO timestamp of freshened telemetry, present after a successful ping. */
  fetchedAt?: string;
  /** Failure reason, present only when `action` is `failed`. */
  error?: string;
};

/** The versioned result document {@link runPriming} emits. */
export type PrimingResponse = {
  schemaVersion: typeof PRIMING_SCHEMA_VERSION;
  generatedAt: string;
  provider: string;
  enabled: boolean;
  dryRun: boolean;
  /** Count of synthetic pings actually issued (0 whenever the gate is off). */
  syntheticPingsIssued: number;
  outcomes: PrimingOutcome[];
};

export type RunPrimingOptions = {
  /** The plan to actuate. */
  plan: PrimingPlan;
  /** The registry, so the executor can resolve each account for the prober. */
  registry: AccountRegistry;
  /** The synthetic-ping seam. Not called for non-synthetic items or a dry run. */
  prober: PrimingProber;
  /** The actuation clock (ISO). */
  now: string;
  /** Preview only: issue no synthetic pings. */
  dryRun?: boolean;
};

/**
 * Actuate a priming plan. Issues the minimal synthetic ping for each
 * `prime-via-synthetic` item and reports what it did. A per-account ping failure
 * is isolated to that account and never aborts the others. It has NO side effect
 * besides the injected prober's read-only call: it writes no credential store,
 * records no tripwire, and never routes or switches.
 *
 * The zero-synthetic-when-off invariant is mechanical here: a `disabled` plan
 * has no `prime-via-synthetic` items, so `syntheticPingsIssued` is always 0 when
 * the gate is off. A dry run also issues zero pings.
 */
export async function runPriming(
  options: RunPrimingOptions,
): Promise<PrimingResponse> {
  const { plan, registry, prober, now } = options;
  const dryRun = options.dryRun ?? false;
  const byId = new Map(registry.accounts.map((item) => [item.id, item]));

  const outcomes: PrimingOutcome[] = [];
  let syntheticPingsIssued = 0;

  for (const item of plan.items) {
    if (item.status === "disabled") {
      outcomes.push({
        account: item.account,
        provider: item.provider,
        status: item.status,
        action: "skipped-disabled",
      });
      continue;
    }
    if (item.status === "primed") {
      outcomes.push({
        account: item.account,
        provider: item.provider,
        status: item.status,
        action: "primed",
      });
      continue;
    }
    if (item.status === "prime-via-real-work") {
      outcomes.push({
        account: item.account,
        provider: item.provider,
        status: item.status,
        action: "deferred-to-real-work",
      });
      continue;
    }

    // prime-via-synthetic: the one path that touches the prober.
    if (dryRun) {
      outcomes.push({
        account: item.account,
        provider: item.provider,
        status: item.status,
        action: "dry-run",
      });
      continue;
    }

    const account = byId.get(item.account);
    if (!account) {
      outcomes.push({
        account: item.account,
        provider: item.provider,
        status: item.status,
        action: "failed",
        error: "account not found in registry",
      });
      continue;
    }

    try {
      const result = await prober(account);
      syntheticPingsIssued += 1;
      if (result.ok) {
        const outcome: PrimingOutcome = {
          account: item.account,
          provider: item.provider,
          status: item.status,
          action: "pinged",
          authVerified: result.authVerified,
        };
        if (result.fetchedAt !== undefined)
          outcome.fetchedAt = result.fetchedAt;
        outcomes.push(outcome);
      } else {
        outcomes.push({
          account: item.account,
          provider: item.provider,
          status: item.status,
          action: "failed",
          authVerified: result.authVerified,
          error: result.error ?? "synthetic ping failed",
        });
      }
    } catch (error) {
      syntheticPingsIssued += 1;
      outcomes.push({
        account: item.account,
        provider: item.provider,
        status: item.status,
        action: "failed",
        error: describeError(error),
      });
    }
  }

  return {
    schemaVersion: PRIMING_SCHEMA_VERSION,
    generatedAt: now,
    provider: plan.provider,
    enabled: plan.enabled,
    dryRun,
    syntheticPingsIssued,
    outcomes,
  };
}

// --- cheapest safe synthetic call catalog ---------------------------------

/**
 * Per-provider description of the cheapest safe synthetic call priming uses, and
 * why it is safe. The chosen call is always the provider's own read-only usage
 * read (the same request `quota-axi` already makes to report a window), routed
 * through the shared usage cache. It is the cheapest possible priming call
 * because it spends NO model tokens, and it is safe because it only reads usage
 * metadata: it never runs a completion, never mutates provider state, and never
 * touches a reset clock. This catalog is data for the report, not behavior.
 */
export type SyntheticPingDescriptor = {
  provider: string;
  /** The cheapest safe call, described for the report. */
  call: string;
  /** Why the call is safe (no spend, no state change, no reset-clock effect). */
  rationale: string;
};

export const SYNTHETIC_PING_CATALOG: Record<string, SyntheticPingDescriptor> = {
  claude: {
    provider: "claude",
    call: "read-only OAuth usage read (the same first-party usage endpoint quota-axi reports from), via the shared usage cache",
    rationale:
      "usage-metadata GET only: spends no model tokens, mutates no provider state, and does not advance or reset any quota reset clock",
  },
  codex: {
    provider: "codex",
    call: "read-only OAuth usage read (or the read-only app-server JSON-RPC probe), via the shared usage cache",
    rationale:
      "usage-metadata read only: spends no model tokens, never launches a billed completion, and touches no reset clock",
  },
  cursor: {
    provider: "cursor",
    call: "read-only dashboard usage read, via the shared usage cache",
    rationale:
      "usage-metadata read only: no editor completion, no provider mutation, no reset-clock effect",
  },
  copilot: {
    provider: "copilot",
    call: "read-only Copilot usage/entitlement read, via the shared usage cache",
    rationale:
      "usage-metadata read only: no completion, no provider mutation, no reset-clock effect",
  },
  grok: {
    provider: "grok",
    call: "read-only consumer-quota read (the GetGrokCreditsConfig usage read), via the shared usage cache",
    rationale:
      "usage-metadata read only: spends no model tokens, mutates nothing, and touches no reset clock",
  },
  kimi: {
    provider: "kimi",
    call: "read-only usage read, via the shared usage cache",
    rationale:
      "usage-metadata read only: no completion, no provider mutation, no reset-clock effect",
  },
  opencode: {
    provider: "opencode",
    call: "credential validity read (sign-in proof only; OpenCode publishes no readable usage endpoint), via the shared usage cache",
    rationale:
      "verifies auth without any completion or provider mutation, and touches no reset clock",
  },
};

/** The cheapest safe synthetic call for a provider, or a generic default. */
export function syntheticPingFor(provider: string): SyntheticPingDescriptor {
  return (
    SYNTHETIC_PING_CATALOG[provider] ?? {
      provider,
      call: "read-only usage read, via the shared usage cache",
      rationale:
        "usage-metadata read only: no completion, no provider mutation, no reset-clock effect",
    }
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// --- real-work routing preference -----------------------------------------

/**
 * One fixed-cost account ranked for real-work routing. Under-used accounts rank
 * first, so routing real work to them (rather than a synthetic ping) is what
 * freshens their telemetry - the "prefer real work" half of the strategy.
 */
export type PrimingRoutePreference = {
  account: string;
  /**
   * The account's minimum observed remaining-percent across its known windows,
   * or undefined when telemetry is unknown. Higher means more headroom (more
   * under-used), so it should receive real work first.
   */
  minRemainingPercent?: number;
  /** True when priming wants real work steered here to keep it fresh. */
  needsWork: boolean;
};

/**
 * Express the priming real-work preference as a pure ranking over the fixed-cost
 * accounts (ADR 0031, Phase 2). This is the "route real work to under-used
 * fixed-cost accounts first" signal a caller folds into `decide`-style routing
 * so synthetic pings stay the last resort. It is advisory ordering only: it
 * never switches, never pings, and returns an empty list when the gate is off.
 *
 * Accounts are ordered by descending headroom (most under-used first); an
 * account with unknown telemetry is treated as maximally in need of a real-work
 * refresh and sorts to the front. Registry order breaks ties so the result is
 * deterministic.
 */
export function primingRoutePreference(
  request: PlanPrimingRequest,
): PrimingRoutePreference[] {
  const provider = request.provider ?? "claude";
  const strategy = request.policy.priming_strategy;
  const enabled = strategy?.enabled === true;
  const preferRealWork = strategy?.prefer_real_work !== false;
  if (!enabled || !preferRealWork) return [];

  const maxTelemetryAgeSeconds =
    strategy?.max_telemetry_age_seconds ?? DEFAULT_MAX_TELEMETRY_AGE_SECONDS;

  const fixedCostAccounts = request.registry.accounts.filter(
    (account) =>
      account.cost_class === "fixed" && account.provider === provider,
  );

  const ranked = fixedCostAccounts.map((account, index) => {
    const telemetry = request.telemetry[account.id];
    const minRemainingPercent = minRemaining(telemetry);
    return {
      account: account.id,
      index,
      minRemainingPercent,
      needsWork: primingNeeds(telemetry, maxTelemetryAgeSeconds).length > 0,
    };
  });

  ranked.sort((a, b) => {
    const aScore = a.minRemainingPercent ?? Number.POSITIVE_INFINITY;
    const bScore = b.minRemainingPercent ?? Number.POSITIVE_INFINITY;
    if (aScore !== bScore) return bScore - aScore;
    return a.index - b.index;
  });

  return ranked.map(({ account, minRemainingPercent, needsWork }) => {
    const preference: PrimingRoutePreference = { account, needsWork };
    if (minRemainingPercent !== undefined) {
      preference.minRemainingPercent = minRemainingPercent;
    }
    return preference;
  });
}

function minRemaining(
  telemetry: PrimingTelemetry | undefined,
): number | undefined {
  if (!telemetry || telemetry.freshness === "unknown") return undefined;
  const values = telemetry.windows
    ? Object.values(telemetry.windows).filter((value) => Number.isFinite(value))
    : [];
  if (values.length === 0) return undefined;
  return Math.min(...values);
}

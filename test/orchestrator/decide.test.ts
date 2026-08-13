import { describe, expect, it } from "vitest";
import {
  DECISION_SCHEMA_VERSION,
  decide,
  type AccountObservation,
  type DecideRequest,
} from "../../src/orchestrator/decide.js";
import type { AccountRegistry, Policy } from "../../src/orchestrator/types.js";

/**
 * Fixture-driven tests for the pure account-switch decider (ADR 0031, Phase 1).
 * Everything here is offline: registry + policy + observed windows in, a
 * versioned decision out, with zero side effects.
 *
 * The baseline mirrors `examples/orchestrator`: a fixed Max account and a fixed
 * Pro account in the preferred tier, a metered Team seat as the fallback.
 */

const NOW = "2026-08-13T21:00:00.000Z";

function registry(): AccountRegistry {
  return {
    schema_version: 1,
    accounts: [
      {
        id: "claude-max-primary",
        provider: "claude",
        label: "Claude Max (primary)",
        plan: "max",
        cost_class: "fixed",
        priority_tier: 0,
        harness_eligibility: ["jcode"],
        binding: "global",
        credential_store_ref: "claude:oauth:max-primary",
        captain_reserve: { seven_day: 10 },
      },
      {
        id: "claude-pro-personal",
        provider: "claude",
        label: "Claude Pro (personal)",
        plan: "pro",
        cost_class: "fixed",
        priority_tier: 1,
        harness_eligibility: ["jcode"],
        binding: "global",
        credential_store_ref: "claude:oauth:personal",
      },
      {
        id: "claude-team-seat-a",
        provider: "claude",
        label: "Claude Team (seat A)",
        plan: "team",
        cost_class: "metered",
        priority_tier: 2,
        harness_eligibility: ["jcode"],
        binding: "per-session",
        credential_store_ref: "claude:oauth:team-seat-a",
      },
    ],
  };
}

function policy(): Policy {
  return {
    schema_version: 1,
    captain_reserve: { seven_day: 5 },
    tiers: [
      {
        name: "fixed-cost-first",
        pools: [
          {
            accounts: ["claude-max-primary", "claude-pro-personal"],
            min_reserve: { five_hour: 5 },
          },
        ],
      },
      {
        name: "metered-fallback",
        pools: [{ accounts: ["claude-team-seat-a"] }],
      },
    ],
  };
}

/** A fully-fresh, plenty-of-headroom observation for every window. */
function healthy(): AccountObservation {
  return { freshness: "known", windows: { five_hour: 80, seven_day: 80 } };
}

function request(overrides: Partial<DecideRequest> = {}): DecideRequest {
  return {
    registry: registry(),
    policy: policy(),
    now: NOW,
    observations: {
      "claude-max-primary": healthy(),
      "claude-pro-personal": healthy(),
      "claude-team-seat-a": healthy(),
    },
    ...overrides,
  };
}

describe("decide - shape and versioning", () => {
  it("emits a versioned decision naming provider and harness", () => {
    const result = decide(request());
    expect(result.schemaVersion).toBe(DECISION_SCHEMA_VERSION);
    expect(result.generatedAt).toBe(NOW);
    expect(result.provider).toBe("claude");
    expect(result.harness).toBe("jcode");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].scope).toBe("all-sessions");
  });

  it("is pure: does not mutate its request", () => {
    const req = request();
    const snapshot = JSON.parse(JSON.stringify(req));
    decide(req);
    expect(req).toEqual(snapshot);
  });

  it("decides per supplied session", () => {
    const result = decide(
      request({
        sessions: [
          { id: "session-a", currentAccount: "claude-max-primary" },
          { id: "session-b" },
        ],
      }),
    );
    expect(result.decisions.map((d) => d.scope)).toEqual([
      "session-a",
      "session-b",
    ]);
  });
});

describe("decide - fresh selection and tier fallback across plans", () => {
  it("selects the top fixed-cost account when all are healthy", () => {
    const result = decide(request({ sessions: [{ id: "s" }] }));
    const decision = result.decisions[0];
    expect(decision.action).toBe("switch");
    expect(decision.chosenAccount).toBe("claude-max-primary");
    expect(decision.reasons.some((r) => r.code === "selected_available")).toBe(
      true,
    );
  });

  it("falls through to the metered account ONLY after every fixed-cost account is exhausted", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 2, seven_day: 80 },
          },
          "claude-pro-personal": {
            freshness: "known",
            windows: { five_hour: 3, seven_day: 80 },
          },
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.chosenAccount).toBe("claude-team-seat-a");
    // The metered account is a genuine fallback: both fixed accounts were
    // skipped for a crossed reserve floor before it was chosen.
    const skips = decision.reasons.filter(
      (r) => r.code === "skipped_reserve_crossed",
    );
    expect(skips.map((r) => r.account)).toEqual([
      "claude-max-primary",
      "claude-pro-personal",
    ]);
  });

  it("never prefers a metered account over an available fixed one, even if policy mis-orders tiers", () => {
    const misordered = policy();
    // Put the metered fallback FIRST in author order.
    misordered.tiers = [misordered.tiers[1], misordered.tiers[0]];
    const result = decide(
      request({ policy: misordered, sessions: [{ id: "s" }] }),
    );
    expect(result.decisions[0].chosenAccount).toBe("claude-max-primary");
  });
});

describe("decide - reserve floors", () => {
  it("skips an account whose pool min_reserve floor is crossed", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 4, seven_day: 80 },
          },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.chosenAccount).toBe("claude-pro-personal");
    const skip = decision.reasons.find(
      (r) => r.code === "skipped_reserve_crossed",
    );
    expect(skip?.account).toBe("claude-max-primary");
    expect(skip?.detail).toMatchObject({
      window: "five_hour",
      floor: 5,
      remaining: 4,
      source: "pool",
    });
  });

  it("honors the policy-level captain_reserve floor", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          // seven_day at 4 crosses the policy captain_reserve of 5.
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 4 },
          },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const skip = result.decisions[0].reasons.find(
      (r) => r.code === "skipped_reserve_crossed",
    );
    // account_captain (Max: seven_day 10) is more conservative than the policy
    // floor (5), so it wins the combined floor and is the recorded source.
    expect(skip?.detail).toMatchObject({
      window: "seven_day",
      floor: 10,
      source: "account_captain",
    });
  });
});

describe("decide - captain reserve on a flagged account", () => {
  it("applies a higher per-account captain_reserve than the policy floor", () => {
    // Max has account captain_reserve seven_day: 10. seven_day at 8 is above
    // the policy floor 5 but below Max's own 10, so Max is skipped while Pro
    // (no account reserve, policy floor 5) stays available at 8.
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 8 },
          },
          "claude-pro-personal": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 8 },
          },
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.chosenAccount).toBe("claude-pro-personal");
    const skip = decision.reasons.find(
      (r) => r.code === "skipped_reserve_crossed",
    );
    expect(skip?.account).toBe("claude-max-primary");
    expect(skip?.detail).toMatchObject({
      source: "account_captain",
      floor: 10,
    });
  });
});

describe("decide - recorded tripwire (exhausted until T)", () => {
  it("skips an account whose tripwire is still in the future", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": {
            ...healthy(),
            exhaustedUntil: "2026-08-13T23:00:00.000Z",
          },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.chosenAccount).toBe("claude-pro-personal");
    expect(
      decision.reasons.find((r) => r.code === "skipped_tripwire_exhausted")
        ?.account,
    ).toBe("claude-max-primary");
  });

  it("treats an expired tripwire as recovered", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": {
            ...healthy(),
            exhaustedUntil: "2026-08-13T20:00:00.000Z",
          },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    expect(result.decisions[0].chosenAccount).toBe("claude-max-primary");
  });
});

describe("decide - priming gate", () => {
  it("keeps a cooled-down account out until its window recovers to the threshold", () => {
    const gated = policy();
    gated.priming = [
      {
        window: "seven_day",
        resume_at_percent_remaining: 20,
        accounts: ["claude-max-primary"],
      },
    ];
    const result = decide(
      request({
        policy: gated,
        sessions: [{ id: "s" }],
        observations: {
          // 15 remaining is above every reserve floor but below the 20 resume
          // threshold, so the gate holds Max out.
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 15 },
          },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.chosenAccount).toBe("claude-pro-personal");
    expect(
      decision.reasons.find((r) => r.code === "skipped_priming_gated")?.account,
    ).toBe("claude-max-primary");
  });
});

describe("decide - unknown data rule", () => {
  it("prefers a known-good account over one with unknown telemetry", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": { freshness: "unknown", windows: {} },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.chosenAccount).toBe("claude-pro-personal");
    expect(
      decision.reasons.find((r) => r.code === "skipped_unknown_telemetry")
        ?.account,
    ).toBe("claude-max-primary");
  });

  it("treats a wholly missing observation as unknown", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          // max has no observation entry at all.
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    expect(result.decisions[0].chosenAccount).toBe("claude-pro-personal");
  });

  it("uses an unknown account only when no known-good account remains", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": { freshness: "unknown", windows: {} },
          // Both other accounts cross the policy captain seven_day floor (5),
          // leaving only the unknown Max usable.
          "claude-pro-personal": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 1 },
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 1 },
          },
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.chosenAccount).toBe("claude-max-primary");
    expect(
      decision.reasons.some((r) => r.code === "selected_unknown_fallback"),
    ).toBe(true);
  });

  it("never switches away from a working account because a preferred account went unknown", () => {
    const result = decide(
      request({
        sessions: [{ id: "s", currentAccount: "claude-pro-personal" }],
        observations: {
          // The more-preferred Max is unknown; the current Pro is healthy.
          "claude-max-primary": { freshness: "unknown", windows: {} },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.action).toBe("keep");
    expect(decision.chosenAccount).toBe("claude-pro-personal");
  });

  it("keeps the current account even when its own telemetry is unknown", () => {
    const result = decide(
      request({
        sessions: [{ id: "s", currentAccount: "claude-pro-personal" }],
        observations: {
          "claude-max-primary": healthy(),
          "claude-pro-personal": { freshness: "unknown", windows: {} },
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.action).toBe("keep");
    expect(decision.chosenAccount).toBe("claude-pro-personal");
    expect(
      decision.reasons.some((r) => r.code === "kept_current_unknown_telemetry"),
    ).toBe(true);
  });
});

describe("decide - keep vs switch on the current account", () => {
  it("keeps a healthy current account when it is already the most preferred", () => {
    const result = decide(
      request({
        sessions: [{ id: "s", currentAccount: "claude-max-primary" }],
      }),
    );
    const decision = result.decisions[0];
    expect(decision.action).toBe("keep");
    expect(decision.chosenAccount).toBe("claude-max-primary");
    expect(
      decision.reasons.some((r) => r.code === "kept_current_available"),
    ).toBe(true);
  });

  it("returns to a more-preferred available account from a fallback", () => {
    // Running on the metered seat, but the fixed Max has recovered.
    const result = decide(
      request({
        sessions: [{ id: "s", currentAccount: "claude-team-seat-a" }],
      }),
    );
    const decision = result.decisions[0];
    expect(decision.action).toBe("switch");
    expect(decision.chosenAccount).toBe("claude-max-primary");
  });

  it("switches off a current account whose reserve floor is crossed", () => {
    const result = decide(
      request({
        sessions: [{ id: "s", currentAccount: "claude-max-primary" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 2, seven_day: 80 },
          },
          "claude-pro-personal": healthy(),
          "claude-team-seat-a": healthy(),
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.action).toBe("switch");
    expect(decision.chosenAccount).toBe("claude-pro-personal");
    expect(
      decision.reasons.some((r) => r.code === "current_reserve_crossed"),
    ).toBe(true);
  });
});

describe("decide - termination (hold when all exhausted)", () => {
  it("holds rather than looping when every account is exhausted", () => {
    const result = decide(
      request({
        sessions: [{ id: "s", currentAccount: "claude-max-primary" }],
        observations: {
          // Every account crosses the policy captain seven_day floor (5); the
          // metered seat has no five_hour floor, so seven_day is what exhausts
          // it too. Nothing is usable, so the decider holds.
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 1 },
          },
          "claude-pro-personal": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 1 },
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 1 },
          },
        },
      }),
    );
    const decision = result.decisions[0];
    expect(decision.action).toBe("hold");
    expect(decision.chosenAccount).toBeUndefined();
    expect(decision.reasons.some((r) => r.code === "hold_all_exhausted")).toBe(
      true,
    );
  });

  it("holds a fresh session (no current account) when nothing is usable", () => {
    const result = decide(
      request({
        sessions: [{ id: "s" }],
        observations: {
          "claude-max-primary": {
            ...healthy(),
            exhaustedUntil: "2026-08-14T00:00:00.000Z",
          },
          "claude-pro-personal": {
            ...healthy(),
            exhaustedUntil: "2026-08-14T00:00:00.000Z",
          },
          "claude-team-seat-a": {
            ...healthy(),
            exhaustedUntil: "2026-08-14T00:00:00.000Z",
          },
        },
      }),
    );
    expect(result.decisions[0].action).toBe("hold");
  });
});

describe("decide - eligibility filtering", () => {
  it("ignores accounts not eligible for the harness", () => {
    const reg = registry();
    reg.accounts[0].harness_eligibility = ["other-harness"];
    const result = decide(request({ registry: reg, sessions: [{ id: "s" }] }));
    // Max is filtered out, so the top fixed account becomes Pro.
    expect(result.decisions[0].chosenAccount).toBe("claude-pro-personal");
  });

  it("ignores accounts for another provider", () => {
    const reg = registry();
    reg.accounts[0].provider = "codex";
    const result = decide(request({ registry: reg, sessions: [{ id: "s" }] }));
    expect(result.decisions[0].chosenAccount).toBe("claude-pro-personal");
  });
});

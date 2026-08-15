import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TELEMETRY_AGE_SECONDS,
  PRIMING_SCHEMA_VERSION,
  planPriming,
  primingRoutePreference,
  runPriming,
  syntheticPingFor,
  SYNTHETIC_PING_CATALOG,
  type PlanPrimingRequest,
  type PrimeProbeResult,
  type PrimingProber,
  type PrimingTelemetry,
} from "../../src/orchestrator/priming.js";
import type { AccountRegistry, Policy } from "../../src/orchestrator/types.js";

/**
 * Fixture-driven tests for the strategy-gated priming pass (ADR 0031, Phase 2).
 * The planner is pure (registry + policy + telemetry in, a plan out); the
 * executor's only side effect is the injected prober, so a fake prober records
 * every synthetic ping and proves the zero-synthetic-when-off invariant.
 */

const NOW = "2026-08-14T02:00:00.000Z";

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

function policy(enabled: boolean, extra: Partial<Policy> = {}): Policy {
  return {
    schema_version: 1,
    tiers: [
      {
        name: "fixed-cost-first",
        pools: [{ accounts: ["claude-max-primary", "claude-pro-personal"] }],
      },
      {
        name: "metered-fallback",
        pools: [{ accounts: ["claude-team-seat-a"] }],
      },
    ],
    priming_strategy: { enabled },
    ...extra,
  };
}

/** Fresh, verified telemetry: nothing to prime. */
function primed(): PrimingTelemetry {
  return { freshness: "known", authVerified: true, ageSeconds: 60 };
}

function request(
  overrides: Partial<PlanPrimingRequest> = {},
): PlanPrimingRequest {
  return {
    registry: registry(),
    policy: policy(true),
    telemetry: {
      "claude-max-primary": primed(),
      "claude-pro-personal": primed(),
    },
    ...overrides,
  };
}

function fakeProber(
  result: PrimeProbeResult = { ok: true, authVerified: true, fetchedAt: NOW },
): { prober: PrimingProber; calls: string[] } {
  const calls: string[] = [];
  const prober: PrimingProber = async (account) => {
    calls.push(account.id);
    return result;
  };
  return { prober, calls };
}

describe("planPriming", () => {
  it("plans only fixed-cost accounts for the provider", () => {
    const plan = planPriming(request());
    expect(plan.items.map((item) => item.account)).toEqual([
      "claude-max-primary",
      "claude-pro-personal",
    ]);
    // The metered Team seat is never a priming target.
    expect(
      plan.items.find((item) => item.account === "claude-team-seat-a"),
    ).toBeUndefined();
  });

  it("marks fully-fresh verified accounts primed with nothing to do", () => {
    const plan = planPriming(request());
    expect(plan.items.every((item) => item.status === "primed")).toBe(true);
  });

  it("defaults the staleness threshold to the shortest window cycle (5h)", () => {
    const plan = planPriming(request());
    expect(plan.maxTelemetryAgeSeconds).toBe(DEFAULT_MAX_TELEMETRY_AGE_SECONDS);
    expect(DEFAULT_MAX_TELEMETRY_AGE_SECONDS).toBe(5 * 60 * 60);
  });

  it("marks a stale, unknown, or auth-unverified account for a synthetic ping when idle", () => {
    const plan = planPriming(
      request({
        telemetry: {
          "claude-max-primary": {
            freshness: "known",
            authVerified: true,
            ageSeconds: DEFAULT_MAX_TELEMETRY_AGE_SECONDS + 1,
          },
          "claude-pro-personal": { freshness: "unknown" },
        },
        realWorkPending: false,
      }),
    );
    const max = plan.items.find((i) => i.account === "claude-max-primary");
    const pro = plan.items.find((i) => i.account === "claude-pro-personal");
    expect(max?.status).toBe("prime-via-synthetic");
    expect(max?.reasons).toContain("stale_telemetry");
    expect(pro?.status).toBe("prime-via-synthetic");
    expect(pro?.reasons).toContain("unknown_telemetry");
    expect(pro?.reasons).toContain("auth_unverified");
  });

  it("prefers real work: a needy account defers to routing when work is pending", () => {
    const plan = planPriming(
      request({
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
        realWorkPending: true,
      }),
    );
    const max = plan.items.find((i) => i.account === "claude-max-primary");
    expect(max?.status).toBe("prime-via-real-work");
    expect(max?.reasons).toContain("deferred_to_real_work");
    // A missing telemetry entry (claude-pro-personal) also defers, never pings.
    expect(
      plan.items.every((item) => item.status !== "prime-via-synthetic"),
    ).toBe(true);
  });

  it("falls back to a synthetic ping when prefer_real_work is off, even with work pending", () => {
    const plan = planPriming(
      request({
        policy: policy(true, {
          priming_strategy: { enabled: true, prefer_real_work: false },
        }),
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
        realWorkPending: true,
      }),
    );
    const max = plan.items.find((i) => i.account === "claude-max-primary");
    expect(max?.status).toBe("prime-via-synthetic");
  });

  it("gate OFF: every item is disabled and NONE is prime-via-synthetic", () => {
    const plan = planPriming(
      request({
        policy: policy(false),
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
        realWorkPending: false,
      }),
    );
    expect(plan.enabled).toBe(false);
    expect(plan.items.every((item) => item.status === "disabled")).toBe(true);
    expect(
      plan.items.some((item) => item.status === "prime-via-synthetic"),
    ).toBe(false);
  });

  it("absent priming_strategy block is treated as OFF", () => {
    const bare = policy(true);
    delete bare.priming_strategy;
    const plan = planPriming(request({ policy: bare }));
    expect(plan.enabled).toBe(false);
    expect(plan.items.every((item) => item.status === "disabled")).toBe(true);
  });
});

describe("runPriming", () => {
  it("issues a synthetic ping only for prime-via-synthetic items", async () => {
    const plan = planPriming(
      request({
        telemetry: {
          "claude-max-primary": { freshness: "unknown" },
          "claude-pro-personal": primed(),
        },
        realWorkPending: false,
      }),
    );
    const { prober, calls } = fakeProber();
    const response = await runPriming({
      plan,
      registry: registry(),
      prober,
      now: NOW,
    });
    expect(calls).toEqual(["claude-max-primary"]);
    expect(response.syntheticPingsIssued).toBe(1);
    const max = response.outcomes.find(
      (o) => o.account === "claude-max-primary",
    );
    expect(max?.action).toBe("pinged");
    expect(max?.authVerified).toBe(true);
    expect(max?.fetchedAt).toBe(NOW);
    const pro = response.outcomes.find(
      (o) => o.account === "claude-pro-personal",
    );
    expect(pro?.action).toBe("primed");
  });

  it("gate OFF: issues ZERO synthetic pings (acceptance invariant)", async () => {
    const plan = planPriming(
      request({
        policy: policy(false),
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
      }),
    );
    const { prober, calls } = fakeProber();
    const response = await runPriming({
      plan,
      registry: registry(),
      prober,
      now: NOW,
    });
    expect(calls).toEqual([]);
    expect(response.syntheticPingsIssued).toBe(0);
    expect(
      response.outcomes.every((o) => o.action === "skipped-disabled"),
    ).toBe(true);
  });

  it("prefer-real-work defers issue ZERO synthetic pings", async () => {
    const plan = planPriming(
      request({
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
        realWorkPending: true,
      }),
    );
    const { prober, calls } = fakeProber();
    const response = await runPriming({
      plan,
      registry: registry(),
      prober,
      now: NOW,
    });
    expect(calls).toEqual([]);
    expect(response.syntheticPingsIssued).toBe(0);
    expect(
      response.outcomes.some((o) => o.action === "deferred-to-real-work"),
    ).toBe(true);
  });

  it("dry run issues ZERO synthetic pings and previews the intended pings", async () => {
    const plan = planPriming(
      request({
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
        realWorkPending: false,
      }),
    );
    const { prober, calls } = fakeProber();
    const response = await runPriming({
      plan,
      registry: registry(),
      prober,
      now: NOW,
      dryRun: true,
    });
    expect(calls).toEqual([]);
    expect(response.syntheticPingsIssued).toBe(0);
    expect(response.dryRun).toBe(true);
    const max = response.outcomes.find(
      (o) => o.account === "claude-max-primary",
    );
    expect(max?.action).toBe("dry-run");
  });

  it("isolates a per-account ping failure and continues the others", async () => {
    const plan = planPriming(
      request({
        telemetry: {
          "claude-max-primary": { freshness: "unknown" },
          "claude-pro-personal": { freshness: "unknown" },
        },
        realWorkPending: false,
      }),
    );
    const calls: string[] = [];
    const prober: PrimingProber = async (account) => {
      calls.push(account.id);
      if (account.id === "claude-max-primary") {
        throw new Error("boom");
      }
      return { ok: true, authVerified: true, fetchedAt: NOW };
    };
    const response = await runPriming({
      plan,
      registry: registry(),
      prober,
      now: NOW,
    });
    expect(calls).toEqual(["claude-max-primary", "claude-pro-personal"]);
    const max = response.outcomes.find(
      (o) => o.account === "claude-max-primary",
    );
    const pro = response.outcomes.find(
      (o) => o.account === "claude-pro-personal",
    );
    expect(max?.action).toBe("failed");
    expect(max?.error).toBe("boom");
    expect(pro?.action).toBe("pinged");
  });

  it("reports a prober ok:false as a failed outcome", async () => {
    const plan = planPriming(
      request({
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
        realWorkPending: false,
      }),
    );
    const { prober } = fakeProber({
      ok: false,
      authVerified: false,
      error: "auth expired",
    });
    const response = await runPriming({
      plan,
      registry: registry(),
      prober,
      now: NOW,
    });
    const max = response.outcomes.find(
      (o) => o.account === "claude-max-primary",
    );
    expect(max?.action).toBe("failed");
    expect(max?.error).toBe("auth expired");
    expect(response.schemaVersion).toBe(PRIMING_SCHEMA_VERSION);
  });
});

describe("syntheticPingFor", () => {
  it("names a read-only usage read as the cheapest safe call for every provider", () => {
    for (const provider of Object.keys(SYNTHETIC_PING_CATALOG)) {
      const descriptor = syntheticPingFor(provider);
      expect(descriptor.call.toLowerCase()).toContain("read");
      // No reset-clock claim: the rationale must state it touches no reset clock.
      expect(descriptor.rationale.toLowerCase()).toMatch(/reset[ -]clock/);
    }
  });

  it("falls back to a generic read-only descriptor for an unknown provider", () => {
    const descriptor = syntheticPingFor("mystery");
    expect(descriptor.provider).toBe("mystery");
    expect(descriptor.call.toLowerCase()).toContain("read-only");
  });
});

describe("primingRoutePreference", () => {
  it("ranks the most under-used fixed-cost account first (route real work there)", () => {
    const preference = primingRoutePreference(
      request({
        telemetry: {
          "claude-max-primary": {
            freshness: "known",
            authVerified: true,
            windows: { five_hour: 40, seven_day: 55 },
          },
          "claude-pro-personal": {
            freshness: "known",
            authVerified: true,
            windows: { five_hour: 90, seven_day: 80 },
          },
        },
      }),
    );
    // Pro has more headroom (min 80) than Max (min 40): route work to Pro first.
    expect(preference.map((p) => p.account)).toEqual([
      "claude-pro-personal",
      "claude-max-primary",
    ]);
  });

  it("sorts an unknown-telemetry account to the front (needs a real-work refresh)", () => {
    const preference = primingRoutePreference(
      request({
        telemetry: {
          "claude-max-primary": {
            freshness: "known",
            authVerified: true,
            windows: { five_hour: 90 },
          },
          "claude-pro-personal": { freshness: "unknown" },
        },
      }),
    );
    expect(preference[0].account).toBe("claude-pro-personal");
    expect(preference[0].needsWork).toBe(true);
    expect(preference[0].minRemainingPercent).toBeUndefined();
  });

  it("returns an empty preference when the gate is off", () => {
    expect(primingRoutePreference(request({ policy: policy(false) }))).toEqual(
      [],
    );
  });

  it("returns an empty preference when prefer_real_work is off", () => {
    const preference = primingRoutePreference(
      request({
        policy: policy(true, {
          priming_strategy: { enabled: true, prefer_real_work: false },
        }),
      }),
    );
    expect(preference).toEqual([]);
  });
});

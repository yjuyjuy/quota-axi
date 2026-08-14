import { describe, expect, it } from "vitest";
import type {
  ClaudeHarnessSurface,
  ClaudeSwitchOutcome,
} from "../../src/orchestrator/claude-surface.js";
import type { DecisionResponse } from "../../src/orchestrator/decide.js";
import type {
  JcodeSessionSurface,
  SwitchAccountRequest,
  SwitchAccountResult,
} from "../../src/orchestrator/jcode-surface.js";
import { runSwitch } from "../../src/orchestrator/switch.js";
import type { TripwireRecord } from "../../src/orchestrator/tripwire-store.js";

function fakeSurface(
  overrides: Partial<{
    switchAccount: (r: SwitchAccountRequest) => Promise<SwitchAccountResult>;
  }> = {},
): { surface: JcodeSessionSurface; calls: SwitchAccountRequest[] } {
  const calls: SwitchAccountRequest[] = [];
  const surface: JcodeSessionSurface = {
    async listSessions() {
      return [];
    },
    async switchAccount(request) {
      calls.push(request);
      if (overrides.switchAccount) return overrides.switchAccount(request);
      return appliedFor(request);
    },
  };
  return { surface, calls };
}

/** A clean applied outcome for whichever scope the request targets. */
function appliedFor(request: SwitchAccountRequest): SwitchAccountResult {
  const sessionId = request.all ? "some-session" : (request.session ?? "");
  return {
    outcomes: [
      {
        sessionId,
        ok: true,
        account: request.account,
        deferred: false,
      },
    ],
  };
}

function decision(decisions: DecisionResponse["decisions"]): DecisionResponse {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T02:00:00.000Z",
    provider: "claude",
    harness: "jcode",
    decisions,
  };
}

const NOW = "2026-08-14T02:00:00.000Z";

describe("runSwitch", () => {
  it("actuates a switch decision onto the chosen account per scope", async () => {
    const { surface, calls } = fakeSurface();
    const recorded: Record<string, TripwireRecord>[] = [];
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          currentAccount: "claude-team-seat-a",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: (u) => recorded.push(u),
      now: NOW,
      recoverAfterSeconds: 3600,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      account: "claude-max-primary",
      session: "session-a",
    });
    expect(response.outcomes[0].status).toBe("applied");
    // Not rotated off for exhaustion, so no tripwire.
    expect(recorded).toHaveLength(0);
  });

  it("maps the all-sessions scope onto a single --all switch", async () => {
    const { surface, calls } = fakeSurface();
    await runSwitch({
      decision: decision([
        {
          scope: "all-sessions",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(calls[0]).toEqual({ account: "claude-max-primary", all: true });
  });

  it("issues no switch for a keep or hold decision", async () => {
    const { surface, calls } = fakeSurface();
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "keep",
          currentAccount: "claude-max-primary",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "kept_current_available" }],
        },
        {
          scope: "session-b",
          action: "hold",
          reasons: [{ code: "hold_all_exhausted" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(calls).toHaveLength(0);
    expect(response.outcomes.map((o) => o.status)).toEqual([
      "skipped",
      "skipped",
    ]);
  });

  it("never passes --model in Phase 1 (account-only)", async () => {
    const { surface, calls } = fakeSurface();
    await runSwitch({
      decision: decision([
        {
          scope: "all-sessions",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(calls[0].model).toBeUndefined();
  });

  it("reports a per-scope failure without aborting siblings", async () => {
    const { surface, calls } = fakeSurface({
      switchAccount: async (request) => {
        if (request.session === "session-a") {
          throw new Error("jcode surface offline");
        }
        return appliedFor(request);
      },
    });
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
        {
          scope: "session-b",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(calls).toHaveLength(2);
    expect(response.outcomes[0].status).toBe("failed");
    expect(response.outcomes[0].error).toContain("jcode surface offline");
    expect(response.outcomes[1].status).toBe("applied");
  });

  it("fails a scope when jcode reports a per-session ok:false, carrying its error", async () => {
    const { surface } = fakeSurface({
      switchAccount: async (request) => ({
        outcomes: [
          {
            sessionId: request.session ?? "",
            ok: false,
            deferred: false,
            error: "unknown account",
          },
        ],
      }),
    });
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(response.outcomes[0].status).toBe("failed");
    expect(response.outcomes[0].error).toContain("unknown account");
    expect(response.outcomes[0].sessionOutcomes?.[0].ok).toBe(false);
  });

  it("reports a deferred scope when jcode defers the switch to the next turn", async () => {
    const { surface } = fakeSurface({
      switchAccount: async (request) => ({
        outcomes: [
          {
            sessionId: request.session ?? "",
            ok: true,
            account: request.account,
            deferred: true,
          },
        ],
      }),
    });
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(response.outcomes[0].status).toBe("deferred");
    expect(response.outcomes[0].sessionOutcomes?.[0].deferred).toBe(true);
  });

  it("fails a scope when jcode matches no live session (empty outcomes)", async () => {
    const { surface } = fakeSurface({
      switchAccount: async () => ({ outcomes: [] }),
    });
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(response.outcomes[0].status).toBe("failed");
    expect(response.outcomes[0].error).toContain("no session outcomes");
  });

  it("records a tripwire when it rotates off an exhausted current account", async () => {
    const { surface } = fakeSurface();
    const recorded: Record<string, TripwireRecord>[] = [];
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          currentAccount: "claude-max-primary",
          chosenAccount: "claude-team-seat-a",
          reasons: [
            {
              code: "current_reserve_crossed",
              account: "claude-max-primary",
              detail: { window: "seven_day" },
            },
            { code: "selected_available", account: "claude-team-seat-a" },
          ],
        },
      ]),
      surface,
      recordTripwires: (u) => recorded.push(u),
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]["claude-max-primary"].exhaustedUntil).toBe(
      "2026-08-14T03:00:00.000Z",
    );
    expect(response.outcomes[0].recordedTripwire).toEqual({
      account: "claude-max-primary",
      exhaustedUntil: "2026-08-14T03:00:00.000Z",
    });
  });

  it("dry-run issues no jcode calls and records no tripwire", async () => {
    const { surface, calls } = fakeSurface();
    const recorded: Record<string, TripwireRecord>[] = [];
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          currentAccount: "claude-max-primary",
          chosenAccount: "claude-team-seat-a",
          reasons: [
            { code: "current_reserve_crossed", account: "claude-max-primary" },
          ],
        },
      ]),
      surface,
      recordTripwires: (u) => recorded.push(u),
      now: NOW,
      recoverAfterSeconds: 3600,
      dryRun: true,
    });
    expect(calls).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(response.dryRun).toBe(true);
    expect(response.outcomes[0].status).toBe("dry-run");
    // The preview still shows the tripwire that WOULD be recorded.
    expect(response.outcomes[0].recordedTripwire?.account).toBe(
      "claude-max-primary",
    );
  });

  it("fails a switch decision that names no chosen account", async () => {
    const { surface, calls } = fakeSurface();
    const response = await runSwitch({
      decision: decision([
        {
          scope: "session-a",
          action: "switch",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(calls).toHaveLength(0);
    expect(response.outcomes[0].status).toBe("failed");
  });
});

function claudeDecision(
  decisions: DecisionResponse["decisions"],
): DecisionResponse {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T02:00:00.000Z",
    provider: "claude",
    harness: "claude",
    decisions,
  };
}

function fakeClaudeSurface(outcome: (target: string) => ClaudeSwitchOutcome): {
  surface: ClaudeHarnessSurface;
  targets: string[];
} {
  const targets: string[] = [];
  const surface: ClaudeHarnessSurface = {
    async switchAccount(target) {
      targets.push(target);
      return outcome(target);
    },
  };
  return { surface, targets };
}

describe("runSwitch claude harness", () => {
  it("actuates a claude switch as one atomic cswap flip", async () => {
    const { surface, targets } = fakeClaudeSurface((target) => ({
      status: "applied",
      target,
      account: { number: 2, email: "b@example.com" },
    }));
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "all-sessions",
          action: "switch",
          currentAccount: "claude-max-primary",
          chosenAccount: "claude-team-seat-a",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      claudeSurface: surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(targets).toEqual(["claude-team-seat-a"]);
    expect(response.outcomes[0].status).toBe("applied");
    expect(response.outcomes[0].claudeActuation).toEqual({
      target: "claude-team-seat-a",
      result: "applied",
    });
  });

  it("reports an already-active flip as applied without a second cswap call", async () => {
    const { surface, targets } = fakeClaudeSurface((target) => ({
      status: "already-active",
      target,
    }));
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "all-sessions",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      claudeSurface: surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(targets).toEqual(["claude-max-primary"]);
    expect(response.outcomes[0].status).toBe("applied");
    expect(response.outcomes[0].claudeActuation?.result).toBe("already-active");
  });

  it("collapses multiple scopes onto the same account into ONE cswap flip", async () => {
    const { surface, targets } = fakeClaudeSurface((target) => ({
      status: "applied",
      target,
    }));
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "session-a",
          action: "switch",
          chosenAccount: "claude-team-seat-a",
          reasons: [{ code: "selected_available" }],
        },
        {
          scope: "session-b",
          action: "switch",
          chosenAccount: "claude-team-seat-a",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      claudeSurface: surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    // The global binding means one flip covers every session, so cswap is
    // called exactly once even though two scopes asked for the same account.
    expect(targets).toEqual(["claude-team-seat-a"]);
    expect(response.outcomes).toHaveLength(2);
    expect(response.outcomes[0].scope).toBe("session-a");
    expect(response.outcomes[1].scope).toBe("session-b");
    expect(response.outcomes.every((o) => o.status === "applied")).toBe(true);
  });

  it("fails closed when the claude surface is missing (cswap unavailable)", async () => {
    const recorded: Record<string, TripwireRecord>[] = [];
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "all-sessions",
          action: "switch",
          currentAccount: "claude-max-primary",
          chosenAccount: "claude-team-seat-a",
          reasons: [
            { code: "current_reserve_crossed", account: "claude-max-primary" },
          ],
        },
      ]),
      recordTripwires: (u) => recorded.push(u),
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(response.outcomes[0].status).toBe("failed");
    expect(response.outcomes[0].error).toContain("cswap is unavailable");
    // A failed switch never rotated off the current account, so no tripwire is
    // recorded that would wrongly quarantine a still-current account.
    expect(recorded).toHaveLength(0);
    expect(response.outcomes[0].recordedTripwire).toBeUndefined();
  });

  it("surfaces a cswap unavailable outcome as a fail-closed refusal", async () => {
    const { surface } = fakeClaudeSurface((target) => ({
      status: "unavailable",
      target,
      error: "cswap (`cswap`) is not installed or not on PATH",
    }));
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "all-sessions",
          action: "switch",
          chosenAccount: "claude-team-seat-a",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      claudeSurface: surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(response.outcomes[0].status).toBe("failed");
    expect(response.outcomes[0].error).toContain("not installed");
  });

  it("surfaces a cswap handled failure as a failed outcome", async () => {
    const { surface } = fakeClaudeSurface((target) => ({
      status: "failed",
      target,
      error: "Invalid account identifier: nope",
    }));
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "all-sessions",
          action: "switch",
          chosenAccount: "nope",
          reasons: [{ code: "selected_available" }],
        },
      ]),
      claudeSurface: surface,
      recordTripwires: () => {},
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(response.outcomes[0].status).toBe("failed");
    expect(response.outcomes[0].error).toBe("Invalid account identifier: nope");
  });

  it("dry-run issues no cswap flip and records no tripwire", async () => {
    const { surface, targets } = fakeClaudeSurface((target) => ({
      status: "applied",
      target,
    }));
    const recorded: Record<string, TripwireRecord>[] = [];
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "all-sessions",
          action: "switch",
          currentAccount: "claude-max-primary",
          chosenAccount: "claude-team-seat-a",
          reasons: [
            { code: "current_reserve_crossed", account: "claude-max-primary" },
          ],
        },
      ]),
      claudeSurface: surface,
      recordTripwires: (u) => recorded.push(u),
      now: NOW,
      recoverAfterSeconds: 3600,
      dryRun: true,
    });
    expect(targets).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(response.outcomes[0].status).toBe("dry-run");
    expect(response.outcomes[0].recordedTripwire?.account).toBe(
      "claude-max-primary",
    );
  });

  it("records a tripwire for a rotated-off exhausted claude account", async () => {
    const { surface } = fakeClaudeSurface((target) => ({
      status: "applied",
      target,
    }));
    const recorded: Record<string, TripwireRecord>[] = [];
    const response = await runSwitch({
      decision: claudeDecision([
        {
          scope: "all-sessions",
          action: "switch",
          currentAccount: "claude-max-primary",
          chosenAccount: "claude-team-seat-a",
          reasons: [
            {
              code: "current_reserve_crossed",
              account: "claude-max-primary",
              detail: { window: "seven_day" },
            },
            { code: "selected_available", account: "claude-team-seat-a" },
          ],
        },
      ]),
      claudeSurface: surface,
      recordTripwires: (u) => recorded.push(u),
      now: NOW,
      recoverAfterSeconds: 3600,
    });
    expect(response.outcomes[0].status).toBe("applied");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]["claude-max-primary"].exhaustedUntil).toBe(
      "2026-08-14T03:00:00.000Z",
    );
  });
});

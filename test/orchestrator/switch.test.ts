import { describe, expect, it } from "vitest";
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
      return { application: "applied" };
    },
  };
  return { surface, calls };
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
        return { application: "applied" };
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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { decideCommand } from "../../src/orchestrator/decide-command.js";
import type { DecisionResponse } from "../../src/orchestrator/decide.js";
import type {
  JcodeSessionSurface,
  SwitchAccountRequest,
  SwitchAccountResult,
} from "../../src/orchestrator/jcode-surface.js";
import {
  parseSwitchFlags,
  switchCommand,
} from "../../src/orchestrator/switch-command.js";
import { TripwireStore } from "../../src/orchestrator/tripwire-store.js";
import type { SwitchResponse } from "../../src/orchestrator/switch.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
});

function scratch(): {
  registry: string;
  policy: string;
  observations: string;
  tripwires: string;
  decision: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-switch-cli-"));
  return {
    registry: join(tempDir, "accounts.yaml"),
    policy: join(tempDir, "policy.yaml"),
    observations: join(tempDir, "observations.json"),
    tripwires: join(tempDir, "tripwires.json"),
    decision: join(tempDir, "decision.json"),
  };
}

const REGISTRY = `schema_version: 1
accounts:
  - id: claude-max-primary
    provider: claude
    label: Claude Max
    cost_class: fixed
    priority_tier: 0
    harness_eligibility: [jcode]
    binding: global
    credential_store_ref: claude:oauth:max
  - id: claude-team-seat-a
    provider: claude
    label: Claude Team
    cost_class: metered
    priority_tier: 2
    harness_eligibility: [jcode]
    binding: per-session
    credential_store_ref: claude:oauth:team
`;

const POLICY = `schema_version: 1
captain_reserve:
  seven_day: 5
tiers:
  - name: fixed-cost-first
    pools:
      - accounts: [claude-max-primary]
  - name: metered-fallback
    pools:
      - accounts: [claude-team-seat-a]
`;

function writeBaseline(paths: { registry: string; policy: string }): void {
  writeFileSync(paths.registry, REGISTRY);
  writeFileSync(paths.policy, POLICY);
}

function recordingSurface(): {
  surface: JcodeSessionSurface;
  calls: SwitchAccountRequest[];
} {
  const calls: SwitchAccountRequest[] = [];
  const surface: JcodeSessionSurface = {
    async listSessions() {
      return [];
    },
    async switchAccount(request): Promise<SwitchAccountResult> {
      calls.push(request);
      return {
        outcomes: [
          {
            sessionId: request.all ? "some-session" : (request.session ?? ""),
            ok: true,
            account: request.account,
            deferred: false,
          },
        ],
      };
    },
  };
  return { surface, calls };
}

const CONSTANT_NOW = () => "2026-08-14T02:00:00.000Z";

describe("switch command flags", () => {
  it("requires a decision source", () => {
    expect(() => parseSwitchFlags([])).toThrow(/requires a decision/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseSwitchFlags(["--bogus"])).toThrow(
      "unknown argument: --bogus",
    );
  });

  it("accepts --observations as a decision source", () => {
    const flags = parseSwitchFlags(["--observations", "./o.json"]);
    expect(flags.observationsPath).toBe("./o.json");
    expect(flags.dryRun).toBe(false);
  });
});

describe("switch command", () => {
  it("re-runs decide internally and actuates the switch onto the fixed account", async () => {
    const paths = scratch();
    writeBaseline(paths);
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-14T02:00:00.000Z",
        sessions: [{ id: "session-a", currentAccount: "claude-team-seat-a" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { seven_day: 80 },
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { seven_day: 80 },
          },
        },
      }),
    );

    const { surface, calls } = recordingSurface();
    const raw = await switchCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        paths.observations,
        "--tripwires",
        paths.tripwires,
        "--json",
      ],
      undefined,
      {
        surface,
        tripwireStore: new TripwireStore({ path: paths.tripwires }),
        now: CONSTANT_NOW,
      },
    );

    const response = JSON.parse(raw) as SwitchResponse;
    expect(response.schemaVersion).toBe(1);
    expect(response.dryRun).toBe(false);
    expect(calls).toEqual([
      { account: "claude-max-primary", session: "session-a" },
    ]);
    expect(response.outcomes[0].status).toBe("applied");
  });

  it("consumes a decision file directly and actuates all-sessions as --all", async () => {
    const paths = scratch();
    const decision: DecisionResponse = {
      schemaVersion: 1,
      generatedAt: "2026-08-14T02:00:00.000Z",
      provider: "claude",
      harness: "jcode",
      decisions: [
        {
          scope: "all-sessions",
          action: "switch",
          chosenAccount: "claude-max-primary",
          reasons: [{ code: "selected_available" }],
        },
      ],
    };
    writeFileSync(paths.decision, JSON.stringify(decision));

    const { surface, calls } = recordingSurface();
    await switchCommand(["--decision", paths.decision, "--json"], undefined, {
      surface,
      tripwireStore: new TripwireStore({ path: paths.tripwires }),
      now: CONSTANT_NOW,
    });
    expect(calls).toEqual([{ account: "claude-max-primary", all: true }]);
  });

  it("issues no switch for a keep/hold decision", async () => {
    const paths = scratch();
    writeBaseline(paths);
    // Max is healthy and the session already runs on it: keep.
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-14T02:00:00.000Z",
        sessions: [{ id: "session-a", currentAccount: "claude-max-primary" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { seven_day: 80 },
          },
        },
      }),
    );
    const { surface, calls } = recordingSurface();
    await switchCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        paths.observations,
        "--tripwires",
        paths.tripwires,
      ],
      undefined,
      {
        surface,
        tripwireStore: new TripwireStore({ path: paths.tripwires }),
        now: CONSTANT_NOW,
      },
    );
    expect(calls).toHaveLength(0);
  });

  it("writes a tripwire that a later decide reads back to keep the account out", async () => {
    const paths = scratch();
    writeBaseline(paths);
    // Max's seven_day reserve is crossed (remaining 3 <= floor 5), session runs
    // on Max, so switch decides to move to the metered seat and record a
    // tripwire on Max.
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-14T02:00:00.000Z",
        sessions: [{ id: "session-a", currentAccount: "claude-max-primary" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { seven_day: 3 },
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { seven_day: 80 },
          },
        },
      }),
    );

    const { surface, calls } = recordingSurface();
    const raw = await switchCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        paths.observations,
        "--tripwires",
        paths.tripwires,
        "--recover-after-seconds",
        "3600",
        "--json",
      ],
      undefined,
      {
        surface,
        tripwireStore: new TripwireStore({ path: paths.tripwires }),
        now: CONSTANT_NOW,
      },
    );
    const response = JSON.parse(raw) as SwitchResponse;
    expect(calls).toEqual([
      { account: "claude-team-seat-a", session: "session-a" },
    ]);
    expect(response.outcomes[0].recordedTripwire?.account).toBe(
      "claude-max-primary",
    );

    // The store now holds the tripwire.
    const stored = new TripwireStore({ path: paths.tripwires }).read();
    expect(stored["claude-max-primary"].exhaustedUntil).toBe(
      "2026-08-14T03:00:00.000Z",
    );

    // A later decide fed that recorded state (via the same tripwires store, at a
    // later `now` still before recovery) keeps Max out even though its telemetry
    // now looks healthy again. We simulate decide reading the store by folding
    // the stored deadline into fresh observations, exactly as switch does.
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-14T02:30:00.000Z",
        sessions: [{ id: "session-a", currentAccount: "claude-team-seat-a" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { seven_day: 90 },
            exhaustedUntil: stored["claude-max-primary"].exhaustedUntil,
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { seven_day: 80 },
          },
        },
      }),
    );
    const decideRaw = await decideCommand([
      "--registry",
      paths.registry,
      "--policy",
      paths.policy,
      "--observations",
      paths.observations,
      "--json",
    ]);
    const decision = JSON.parse(decideRaw) as DecisionResponse;
    // Max is tripwire-exhausted, so the session stays on the metered seat.
    expect(decision.decisions[0].action).toBe("keep");
    expect(decision.decisions[0].chosenAccount).toBe("claude-team-seat-a");
  });

  it("folds the stored tripwire into the internal decide (read-back through the store)", async () => {
    const paths = scratch();
    writeBaseline(paths);
    // Pre-seed a tripwire on Max via the store.
    new TripwireStore({ path: paths.tripwires }).record({
      "claude-max-primary": {
        exhaustedUntil: "2026-08-14T04:00:00.000Z",
        recordedAt: "2026-08-14T01:00:00.000Z",
      },
    });
    // Max looks perfectly healthy in fresh telemetry, session on the seat.
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-14T02:00:00.000Z",
        sessions: [{ id: "session-a", currentAccount: "claude-team-seat-a" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { seven_day: 95 },
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { seven_day: 80 },
          },
        },
      }),
    );

    const { surface, calls } = recordingSurface();
    await switchCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        paths.observations,
        "--tripwires",
        paths.tripwires,
      ],
      undefined,
      {
        surface,
        tripwireStore: new TripwireStore({ path: paths.tripwires }),
        now: CONSTANT_NOW,
      },
    );
    // Because the stored tripwire keeps Max out, the seat is kept: no switch.
    expect(calls).toHaveLength(0);
  });

  it("dry-run issues no jcode calls and writes no tripwire", async () => {
    const paths = scratch();
    writeBaseline(paths);
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-14T02:00:00.000Z",
        sessions: [{ id: "session-a", currentAccount: "claude-max-primary" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { seven_day: 3 },
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { seven_day: 80 },
          },
        },
      }),
    );
    const { surface, calls } = recordingSurface();
    const store = new TripwireStore({ path: paths.tripwires });
    const raw = await switchCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        paths.observations,
        "--tripwires",
        paths.tripwires,
        "--dry-run",
        "--json",
      ],
      undefined,
      { surface, tripwireStore: store, now: CONSTANT_NOW },
    );
    const response = JSON.parse(raw) as SwitchResponse;
    expect(response.dryRun).toBe(true);
    expect(calls).toHaveLength(0);
    expect(store.read()).toEqual({});
    expect(response.outcomes[0].status).toBe("dry-run");
  });

  it("reports validation issues and exits 1 for a bad registry/policy pair", async () => {
    const paths = scratch();
    writeFileSync(paths.registry, REGISTRY);
    writeFileSync(
      paths.policy,
      `schema_version: 1
tiers:
  - name: t
    pools:
      - accounts: [ghost]
`,
    );
    writeFileSync(paths.observations, JSON.stringify({ observations: {} }));
    const { surface } = recordingSurface();
    const raw = await switchCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        paths.observations,
        "--json",
      ],
      undefined,
      {
        surface,
        tripwireStore: new TripwireStore({ path: paths.tripwires }),
        now: CONSTANT_NOW,
      },
    );
    const report = JSON.parse(raw) as { ok: boolean };
    expect(report.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("lists switch in the top-level help", async () => {
    const chunks: string[] = [];
    await main({
      argv: ["--help"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });
    expect(chunks.join("")).toContain(
      "usage: quota-axi [quota|auth|models|validate|decide|switch|prime] [flags]",
    );
  });
});

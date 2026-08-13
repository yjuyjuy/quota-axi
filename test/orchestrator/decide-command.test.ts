import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import {
  decideCommand,
  parseDecideFlags,
} from "../../src/orchestrator/decide-command.js";
import type { DecisionResponse } from "../../src/orchestrator/decide.js";

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
} {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-decide-cli-"));
  return {
    registry: join(tempDir, "accounts.yaml"),
    policy: join(tempDir, "policy.yaml"),
    observations: join(tempDir, "observations.json"),
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
        min_reserve:
          five_hour: 5
  - name: metered-fallback
    pools:
      - accounts: [claude-team-seat-a]
`;

function writeBaseline(paths: { registry: string; policy: string }): void {
  writeFileSync(paths.registry, REGISTRY);
  writeFileSync(paths.policy, POLICY);
}

describe("decide command", () => {
  it("requires --observations", () => {
    expect(() => parseDecideFlags([])).toThrow(/requires --observations/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseDecideFlags(["--bogus"])).toThrow(
      "unknown argument: --bogus",
    );
  });

  it("emits a versioned JSON decision from files with zero side effects", async () => {
    const paths = scratch();
    writeBaseline(paths);
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-13T21:00:00.000Z",
        sessions: [{ id: "session-a", currentAccount: "claude-team-seat-a" }],
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 80 },
          },
          "claude-team-seat-a": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 80 },
          },
        },
      }),
    );

    const raw = await decideCommand([
      "--registry",
      paths.registry,
      "--policy",
      paths.policy,
      "--observations",
      paths.observations,
      "--json",
    ]);
    const decision = JSON.parse(raw) as DecisionResponse;
    expect(decision.schemaVersion).toBe(1);
    expect(decision.provider).toBe("claude");
    expect(decision.decisions[0].scope).toBe("session-a");
    // Running on the metered seat while the fixed Max is healthy: switch up.
    expect(decision.decisions[0].action).toBe("switch");
    expect(decision.decisions[0].chosenAccount).toBe("claude-max-primary");
    expect(process.exitCode).toBeUndefined();
  });

  it("holds when every account is exhausted", async () => {
    const paths = scratch();
    writeBaseline(paths);
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-13T21:00:00.000Z",
        observations: {
          "claude-max-primary": {
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

    const raw = await decideCommand([
      "--registry",
      paths.registry,
      "--policy",
      paths.policy,
      "--observations",
      paths.observations,
      "--json",
    ]);
    const decision = JSON.parse(raw) as DecisionResponse;
    expect(decision.decisions[0].action).toBe("hold");
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

    const raw = await decideCommand([
      "--registry",
      paths.registry,
      "--policy",
      paths.policy,
      "--observations",
      paths.observations,
      "--json",
    ]);
    const report = JSON.parse(raw) as {
      ok: boolean;
      issues: { code: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "unknown_account")).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("errors clearly when the observations file is missing", async () => {
    const paths = scratch();
    writeBaseline(paths);
    await expect(
      decideCommand([
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        join(tempDir ?? "", "does-not-exist.json"),
      ]),
    ).rejects.toThrow(/not found/);
  });

  it("routes decide through main and renders TOON", async () => {
    const paths = scratch();
    writeBaseline(paths);
    writeFileSync(
      paths.observations,
      JSON.stringify({
        now: "2026-08-13T21:00:00.000Z",
        observations: {
          "claude-max-primary": {
            freshness: "known",
            windows: { five_hour: 80, seven_day: 80 },
          },
        },
      }),
    );

    const chunks: string[] = [];
    await main({
      argv: [
        "decide",
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--observations",
        paths.observations,
      ],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });
    const output = chunks.join("");
    expect(output).toContain("provider: claude");
    expect(output).toContain("claude-max-primary");
  });

  it("lists decide in the top-level help", async () => {
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
      "usage: quota-axi [quota|auth|models|validate|decide] [flags]",
    );
  });
});

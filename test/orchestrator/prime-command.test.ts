import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePrimeFlags,
  primeCommand,
} from "../../src/orchestrator/prime-command.js";
import type {
  PrimeProbeResult,
  PrimingProber,
} from "../../src/orchestrator/priming.js";

/**
 * CLI tests for `quota-axi prime` (ADR 0031, Phase 2). The prober is injected so
 * no real provider call is made; the tests assert the gate (zero synthetic
 * pings when off), the real-work preference, and the JSON contract.
 */

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
});

function scratch(): { registry: string; policy: string; telemetry: string } {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-prime-cli-"));
  return {
    registry: join(tempDir, "accounts.yaml"),
    policy: join(tempDir, "policy.yaml"),
    telemetry: join(tempDir, "telemetry.json"),
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
  - id: claude-pro-personal
    provider: claude
    label: Claude Pro
    cost_class: fixed
    priority_tier: 1
    harness_eligibility: [jcode]
    binding: global
    credential_store_ref: claude:oauth:pro
  - id: claude-team-seat-a
    provider: claude
    label: Claude Team
    cost_class: metered
    priority_tier: 2
    harness_eligibility: [jcode]
    binding: per-session
    credential_store_ref: claude:oauth:team
`;

function policyYaml(enabled: boolean): string {
  return `schema_version: 1
tiers:
  - name: fixed-cost-first
    pools:
      - accounts: [claude-max-primary, claude-pro-personal]
  - name: metered-fallback
    pools:
      - accounts: [claude-team-seat-a]
priming_strategy:
  enabled: ${enabled}
`;
}

function writeBaseline(
  paths: { registry: string; policy: string },
  enabled: boolean,
): void {
  writeFileSync(paths.registry, REGISTRY);
  writeFileSync(paths.policy, policyYaml(enabled));
}

function recordingProber(
  result: PrimeProbeResult = {
    ok: true,
    authVerified: true,
    fetchedAt: "2026-08-14T02:00:00.000Z",
  },
): { prober: PrimingProber; calls: string[] } {
  const calls: string[] = [];
  const prober: PrimingProber = async (account) => {
    calls.push(account.id);
    return result;
  };
  return { prober, calls };
}

const NOW = "2026-08-14T02:00:00.000Z";

describe("prime command flags", () => {
  it("requires --telemetry", () => {
    expect(() => parsePrimeFlags([])).toThrow(/requires --telemetry/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parsePrimeFlags(["--bogus", "--telemetry", "t.json"])).toThrow(
      "unknown argument: --bogus",
    );
  });

  it("parses --dry-run and inline --telemetry=", () => {
    const flags = parsePrimeFlags([
      "--dry-run",
      "--telemetry=t.json",
      "--json",
    ]);
    expect(flags.dryRun).toBe(true);
    expect(flags.json).toBe(true);
    expect(flags.telemetryPath).toBe("t.json");
  });
});

describe("prime command", () => {
  it("gate OFF: issues ZERO synthetic pings even when telemetry is stale", async () => {
    const paths = scratch();
    writeBaseline(paths, false);
    writeFileSync(
      paths.telemetry,
      JSON.stringify({
        realWorkPending: false,
        telemetry: {
          "claude-max-primary": { freshness: "unknown" },
          "claude-pro-personal": { freshness: "unknown" },
        },
      }),
    );
    const { prober, calls } = recordingProber();
    const output = await primeCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--telemetry",
        paths.telemetry,
        "--json",
      ],
      undefined,
      { prober, now: () => NOW },
    );
    const parsed = JSON.parse(output);
    expect(calls).toEqual([]);
    expect(parsed.syntheticPingsIssued).toBe(0);
    expect(parsed.enabled).toBe(false);
    expect(
      parsed.outcomes.every(
        (o: { action: string }) => o.action === "skipped-disabled",
      ),
    ).toBe(true);
  });

  it("gate ON, idle fleet: pings only the needy fixed-cost accounts", async () => {
    const paths = scratch();
    writeBaseline(paths, true);
    writeFileSync(
      paths.telemetry,
      JSON.stringify({
        realWorkPending: false,
        telemetry: {
          "claude-max-primary": { freshness: "unknown" },
          "claude-pro-personal": {
            freshness: "known",
            authVerified: true,
            ageSeconds: 60,
          },
        },
      }),
    );
    const { prober, calls } = recordingProber();
    const output = await primeCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--telemetry",
        paths.telemetry,
        "--json",
      ],
      undefined,
      { prober, now: () => NOW },
    );
    const parsed = JSON.parse(output);
    expect(calls).toEqual(["claude-max-primary"]);
    expect(parsed.syntheticPingsIssued).toBe(1);
    const max = parsed.outcomes.find(
      (o: { account: string }) => o.account === "claude-max-primary",
    );
    expect(max.action).toBe("pinged");
  });

  it("gate ON, work pending: prefers real-work routing over synthetic pings", async () => {
    const paths = scratch();
    writeBaseline(paths, true);
    writeFileSync(
      paths.telemetry,
      JSON.stringify({
        realWorkPending: true,
        telemetry: {
          "claude-max-primary": {
            freshness: "known",
            authVerified: true,
            windows: { five_hour: 30 },
          },
          "claude-pro-personal": { freshness: "unknown" },
        },
      }),
    );
    const { prober, calls } = recordingProber();
    const output = await primeCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--telemetry",
        paths.telemetry,
        "--json",
      ],
      undefined,
      { prober, now: () => NOW },
    );
    const parsed = JSON.parse(output);
    expect(calls).toEqual([]);
    expect(parsed.syntheticPingsIssued).toBe(0);
    // The route preference ranks the most under-used account first.
    expect(Array.isArray(parsed.routePreference)).toBe(true);
    expect(parsed.routePreference.length).toBe(2);
  });

  it("dry run issues ZERO pings and previews the intended ping", async () => {
    const paths = scratch();
    writeBaseline(paths, true);
    writeFileSync(
      paths.telemetry,
      JSON.stringify({
        realWorkPending: false,
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
      }),
    );
    const { prober, calls } = recordingProber();
    const output = await primeCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--telemetry",
        paths.telemetry,
        "--dry-run",
        "--json",
      ],
      undefined,
      { prober, now: () => NOW },
    );
    const parsed = JSON.parse(output);
    expect(calls).toEqual([]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.syntheticPingsIssued).toBe(0);
  });

  it("reports the cheapest safe synthetic call per provider in the JSON", async () => {
    const paths = scratch();
    writeBaseline(paths, true);
    writeFileSync(
      paths.telemetry,
      JSON.stringify({
        realWorkPending: false,
        telemetry: { "claude-max-primary": { freshness: "unknown" } },
      }),
    );
    const { prober } = recordingProber();
    const output = await primeCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--telemetry",
        paths.telemetry,
        "--json",
      ],
      undefined,
      { prober, now: () => NOW },
    );
    const parsed = JSON.parse(output);
    const claude = parsed.synthetic.find(
      (s: { provider: string }) => s.provider === "claude",
    );
    expect(claude.call.toLowerCase()).toContain("read-only");
    expect(claude.rationale.toLowerCase()).toMatch(/reset[ -]clock/);
  });

  it("sets exit code 1 and reports issues on an invalid policy", async () => {
    const paths = scratch();
    writeFileSync(paths.registry, REGISTRY);
    writeFileSync(paths.policy, "schema_version: 1\n");
    writeFileSync(paths.telemetry, JSON.stringify({ telemetry: {} }));
    const { prober } = recordingProber();
    const output = await primeCommand(
      [
        "--registry",
        paths.registry,
        "--policy",
        paths.policy,
        "--telemetry",
        paths.telemetry,
        "--json",
      ],
      undefined,
      { prober, now: () => NOW },
    );
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

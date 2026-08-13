import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyStore } from "../../src/orchestrator/store.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function scratch(): {
  registryPath: string;
  policyPath: string;
  snapshotPath: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-orch-store-"));
  return {
    registryPath: join(tempDir, "accounts.yaml"),
    policyPath: join(tempDir, "policy.yaml"),
    snapshotPath: join(tempDir, "last-valid-policy.json"),
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
`;

function policyYaml(tierName: string): string {
  return `schema_version: 1
tiers:
  - name: ${tierName}
    pools:
      - accounts: [claude-max-primary]
`;
}

describe("PolicyStore", () => {
  it("loads a valid pair and snapshots the policy", () => {
    const paths = scratch();
    writeFileSync(paths.registryPath, REGISTRY);
    writeFileSync(paths.policyPath, policyYaml("tier-a"));

    const store = new PolicyStore(paths);
    const result = store.reload();

    expect(result.ok).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.policy?.tiers[0].name).toBe("tier-a");
    expect(store.current?.tiers[0].name).toBe("tier-a");
  });

  it("retains the last valid policy in memory when a later edit is bad", () => {
    const paths = scratch();
    writeFileSync(paths.registryPath, REGISTRY);
    writeFileSync(paths.policyPath, policyYaml("tier-a"));

    const store = new PolicyStore(paths);
    store.reload();

    // Bad edit: policy now references an account not in the registry.
    writeFileSync(
      paths.policyPath,
      `schema_version: 1
tiers:
  - name: broken
    pools:
      - accounts: [ghost]
`,
    );
    const result = store.reload();

    expect(result.ok).toBe(false);
    expect(result.usedFallback).toBe(true);
    expect(result.issues.some((item) => item.code === "unknown_account")).toBe(
      true,
    );
    // The retained fallback is still the previous valid policy.
    expect(result.policy?.tiers[0].name).toBe("tier-a");
    expect(store.current?.tiers[0].name).toBe("tier-a");
  });

  it("recovers the persisted fallback in a fresh process after a bad edit", () => {
    const paths = scratch();
    writeFileSync(paths.registryPath, REGISTRY);
    writeFileSync(paths.policyPath, policyYaml("tier-a"));

    // First process: loads and snapshots the valid policy.
    new PolicyStore(paths).reload();

    // The captain then breaks the file.
    writeFileSync(paths.policyPath, "schema_version: 1\ntiers: nope\n");

    // A brand-new store (fresh process) still serves the persisted fallback.
    const fresh = new PolicyStore(paths);
    const result = fresh.reload();
    expect(result.ok).toBe(false);
    expect(result.usedFallback).toBe(true);
    expect(fresh.current?.tiers[0].name).toBe("tier-a");
  });

  it("reports no fallback when the very first load is invalid", () => {
    const paths = scratch();
    // Registry present but policy missing entirely.
    writeFileSync(paths.registryPath, REGISTRY);

    const store = new PolicyStore(paths);
    const result = store.reload();
    expect(result.ok).toBe(false);
    expect(result.usedFallback).toBe(false);
    expect(result.policy).toBeUndefined();
    expect(store.current).toBeUndefined();
  });

  it("hot-reloads a valid edit picked up by the file watcher", async () => {
    const paths = scratch();
    writeFileSync(paths.registryPath, REGISTRY);
    writeFileSync(paths.policyPath, policyYaml("tier-a"));

    const reloads: string[] = [];
    const store = new PolicyStore({
      ...paths,
      onReload: (result) => {
        if (result.policy) reloads.push(result.policy.tiers[0].name);
      },
    });
    const initial = store.start();
    expect(initial.policy?.tiers[0].name).toBe("tier-a");

    try {
      writeFileSync(paths.policyPath, policyYaml("tier-b"));
      await waitFor(() => store.current?.tiers[0].name === "tier-b");
      expect(store.current?.tiers[0].name).toBe("tier-b");
      expect(reloads).toContain("tier-b");
    } finally {
      store.stop();
    }
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

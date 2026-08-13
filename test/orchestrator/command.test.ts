import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { validateCommand } from "../../src/orchestrator/command.js";
import type { ValidationIssue } from "../../src/orchestrator/types.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
});

function scratch(): { registry: string; policy: string; cache: string } {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-validate-cli-"));
  return {
    registry: join(tempDir, "accounts.yaml"),
    policy: join(tempDir, "policy.yaml"),
    cache: join(tempDir, "cache"),
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

const POLICY = `schema_version: 1
tiers:
  - name: fixed-cost-first
    pools:
      - accounts: [claude-max-primary]
`;

describe("validate command", () => {
  it("reports a valid pair and exits zero", async () => {
    const paths = scratch();
    writeFileSync(paths.registry, REGISTRY);
    writeFileSync(paths.policy, POLICY);

    const output = await validateCommand([
      "--registry",
      paths.registry,
      "--policy",
      paths.policy,
    ]);
    expect(output).toContain("valid: true");
    expect(output).toContain("last-valid policy fallback refreshed");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports issues and sets exit code 1 for a bad pair", async () => {
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

    const raw = await validateCommand([
      "--registry",
      paths.registry,
      "--policy",
      paths.policy,
      "--json",
    ]);
    const report = JSON.parse(raw) as {
      valid: boolean;
      issues: ValidationIssue[];
    };
    expect(report.valid).toBe(false);
    expect(report.issues[0].code).toBe("unknown_account");
    expect(process.exitCode).toBe(1);
  });

  it("rejects an unknown validate flag", async () => {
    await expect(validateCommand(["--bogus"])).rejects.toThrow(
      "unknown argument: --bogus",
    );
  });

  it("routes the validate command through main and renders TOON", async () => {
    const paths = scratch();
    writeFileSync(paths.registry, REGISTRY);
    writeFileSync(paths.policy, POLICY);
    process.env.XDG_CACHE_HOME = paths.cache;

    const chunks: string[] = [];
    try {
      await main({
        argv: [
          "validate",
          "--registry",
          paths.registry,
          "--policy",
          paths.policy,
        ],
        binPath: "quota-axi",
        stdout: {
          write(chunk) {
            chunks.push(String(chunk));
            return true;
          },
        },
      });
    } finally {
      delete process.env.XDG_CACHE_HOME;
    }
    expect(chunks.join("")).toContain("valid: true");
  });

  it("lists validate in the top-level help", async () => {
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

import { describe, expect, it } from "vitest";
import { validate, type FileInput } from "../../src/orchestrator/validate.js";
import type { AccountRegistry, Policy } from "../../src/orchestrator/types.js";

/** A minimal, structurally valid registry used as the happy-path baseline. */
function validRegistry(): AccountRegistry {
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
        id: "claude-team-seat-a",
        provider: "claude",
        label: "Claude Team (seat A)",
        cost_class: "metered",
        priority_tier: 2,
        harness_eligibility: ["jcode"],
        binding: "per-session",
        credential_store_ref: "claude:oauth:team-seat-a",
      },
    ],
  };
}

function validPolicy(): Policy {
  return {
    schema_version: 1,
    captain_reserve: { seven_day: 5 },
    tiers: [
      {
        name: "fixed-cost-first",
        pools: [
          { accounts: ["claude-max-primary"], min_reserve: { five_hour: 5 } },
        ],
      },
      {
        name: "metered-fallback",
        pools: [{ accounts: ["claude-team-seat-a"] }],
      },
    ],
    priming: [
      {
        window: "seven_day",
        resume_at_percent_remaining: 20,
        accounts: ["claude-max-primary"],
      },
    ],
  };
}

function ok(value: unknown): FileInput {
  return { status: "success", value };
}

describe("orchestrator validate", () => {
  it("accepts a well-formed registry and policy pair", () => {
    const result = validate(ok(validRegistry()), ok(validPolicy()));
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.registry?.accounts).toHaveLength(2);
    expect(result.policy?.tiers).toHaveLength(2);
  });

  it("reports a missing registry file with an actionable message", () => {
    const result = validate({ status: "missing" }, ok(validPolicy()));
    expect(result.valid).toBe(false);
    const issue = result.issues.find((item) => item.file === "registry");
    expect(issue?.code).toBe("file_missing");
    expect(issue?.message).toMatch(/does not exist/);
  });

  it("reports an unparseable policy file", () => {
    const result = validate(ok(validRegistry()), {
      status: "invalid",
      error: "yaml_parse_error: bad indentation",
    });
    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (item) => item.file === "policy" && item.code === "file_unparseable",
      ),
    ).toBe(true);
  });

  it("requires schema_version and flags an unsupported one", () => {
    const missing = validate(
      ok({ accounts: [] }),
      ok({ ...validPolicy(), schema_version: undefined }),
    );
    expect(
      missing.issues.some(
        (item) =>
          item.path === "schema_version" && item.code === "missing_field",
      ),
    ).toBe(true);

    const unsupported = validate(
      ok({ ...validRegistry(), schema_version: 99 }),
      ok(validPolicy()),
    );
    expect(
      unsupported.issues.some(
        (item) => item.code === "unsupported_schema_version",
      ),
    ).toBe(true);
  });

  it("flags a missing required account field", () => {
    const registry = validRegistry();
    const broken = {
      ...registry,
      accounts: [{ ...registry.accounts[0], cost_class: undefined }],
    };
    const result = validate(ok(broken), ok(validPolicy()));
    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (item) => item.path === "accounts[0].cost_class",
    );
    expect(issue?.code).toBe("missing_field");
  });

  it("rejects an invalid enum value", () => {
    const registry = validRegistry();
    const broken = {
      ...registry,
      accounts: [{ ...registry.accounts[0], binding: "sometimes" }],
    };
    const result = validate(ok(broken), ok(validPolicy()));
    const issue = result.issues.find(
      (item) => item.path === "accounts[0].binding",
    );
    expect(issue?.code).toBe("invalid_value");
    expect(issue?.message).toMatch(/global, per-session/);
  });

  it("rejects a non-integer priority tier", () => {
    const registry = validRegistry();
    const broken = {
      ...registry,
      accounts: [{ ...registry.accounts[0], priority_tier: 1.5 }],
    };
    const result = validate(ok(broken), ok(validPolicy()));
    expect(
      result.issues.some(
        (item) =>
          item.path === "accounts[0].priority_tier" &&
          item.code === "invalid_type",
      ),
    ).toBe(true);
  });

  it("rejects duplicate account ids", () => {
    const registry = validRegistry();
    const broken = {
      ...registry,
      accounts: [registry.accounts[0], registry.accounts[0]],
    };
    const result = validate(ok(broken), ok(validPolicy()));
    expect(
      result.issues.some((item) => item.code === "duplicate_account_id"),
    ).toBe(true);
  });

  it("forbids credential material in the registry", () => {
    const registry = validRegistry();
    const broken = {
      ...registry,
      accounts: [{ ...registry.accounts[0], api_key: "sk-secret" }],
    };
    const result = validate(ok(broken), ok(validPolicy()));
    const issue = result.issues.find(
      (item) => item.code === "credential_material_forbidden",
    );
    expect(issue?.path).toBe("accounts[0].api_key");
    expect(issue?.message).toMatch(/never store credentials/);
  });

  it("catches a policy account not defined in the registry", () => {
    const policy = validPolicy();
    policy.tiers[0].pools[0].accounts = ["ghost-account"];
    const result = validate(ok(validRegistry()), ok(policy));
    const issue = result.issues.find((item) => item.code === "unknown_account");
    expect(issue?.file).toBe("policy");
    expect(issue?.path).toBe("tiers[0].pools[0].accounts[0]");
    expect(issue?.message).toMatch(/ghost-account/);
  });

  it("catches a priming gate referencing an unknown account", () => {
    const policy = validPolicy();
    policy.priming = [
      {
        window: "seven_day",
        resume_at_percent_remaining: 20,
        accounts: ["nope"],
      },
    ];
    const result = validate(ok(validRegistry()), ok(policy));
    expect(
      result.issues.some(
        (item) => item.code === "unknown_account" && item.file === "policy",
      ),
    ).toBe(true);
  });

  it("requires at least one tier", () => {
    const result = validate(
      ok(validRegistry()),
      ok({ schema_version: 1, tiers: [] }),
    );
    expect(result.issues.some((item) => item.code === "empty_tiers")).toBe(
      true,
    );
  });

  it("rejects a reserve floor outside 0-100", () => {
    const policy = validPolicy();
    policy.captain_reserve = { seven_day: 150 };
    const result = validate(ok(validRegistry()), ok(policy));
    const issue = result.issues.find(
      (item) => item.path === "captain_reserve.seven_day",
    );
    expect(issue?.code).toBe("invalid_value");
  });

  it("rejects a priming threshold outside 0-100", () => {
    const policy = validPolicy();
    policy.priming = [{ window: "seven_day", resume_at_percent_remaining: -5 }];
    const result = validate(ok(validRegistry()), ok(policy));
    expect(
      result.issues.some(
        (item) =>
          item.path === "priming[0].resume_at_percent_remaining" &&
          item.code === "invalid_type",
      ),
    ).toBe(true);
  });

  it("accepts an additive model_map object without validating its contents", () => {
    const policy = {
      ...validPolicy(),
      model_map: { claude: { default: "x" } },
    };
    const result = validate(ok(validRegistry()), ok(policy));
    expect(result.valid).toBe(true);
    expect(result.policy?.model_map).toEqual({ claude: { default: "x" } });
  });

  it("rejects a non-object model_map", () => {
    const policy = { ...validPolicy(), model_map: ["not", "a", "map"] };
    const result = validate(ok(validRegistry()), ok(policy));
    expect(
      result.issues.some(
        (item) => item.path === "model_map" && item.code === "invalid_type",
      ),
    ).toBe(true);
  });

  it("collects issues from both files at once", () => {
    const result = validate(
      ok({ schema_version: 1, accounts: "nope" }),
      ok({ schema_version: 1, tiers: "nope" }),
    );
    expect(result.issues.some((item) => item.file === "registry")).toBe(true);
    expect(result.issues.some((item) => item.file === "policy")).toBe(true);
  });

  it("accepts a valid priming_strategy block (ADR 0031 Phase 2)", () => {
    const policy = {
      ...validPolicy(),
      priming_strategy: {
        enabled: true,
        prefer_real_work: true,
        max_telemetry_age_seconds: 18000,
      },
    };
    const result = validate(ok(validRegistry()), ok(policy));
    expect(result.valid).toBe(true);
    expect(result.policy?.priming_strategy).toEqual({
      enabled: true,
      prefer_real_work: true,
      max_telemetry_age_seconds: 18000,
    });
  });

  it("accepts an omitted priming_strategy block", () => {
    const result = validate(ok(validRegistry()), ok(validPolicy()));
    expect(result.valid).toBe(true);
    expect(result.policy?.priming_strategy).toBeUndefined();
  });

  it("rejects a priming_strategy without a boolean enabled", () => {
    const policy = { ...validPolicy(), priming_strategy: { enabled: "yes" } };
    const result = validate(ok(validRegistry()), ok(policy));
    expect(
      result.issues.some(
        (item) =>
          item.path === "priming_strategy.enabled" &&
          item.code === "invalid_type",
      ),
    ).toBe(true);
  });

  it("rejects a negative max_telemetry_age_seconds", () => {
    const policy = {
      ...validPolicy(),
      priming_strategy: { enabled: true, max_telemetry_age_seconds: -1 },
    };
    const result = validate(ok(validRegistry()), ok(policy));
    expect(
      result.issues.some(
        (item) =>
          item.path === "priming_strategy.max_telemetry_age_seconds" &&
          item.code === "invalid_value",
      ),
    ).toBe(true);
  });
});

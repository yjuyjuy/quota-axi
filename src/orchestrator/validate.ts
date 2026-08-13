import {
  ORCHESTRATOR_SCHEMA_VERSION,
  type AccountRegistry,
  type Policy,
  type PolicyPool,
  type PolicyPrimingGate,
  type PolicyTier,
  type RegistryAccount,
  type ValidationIssue,
  type ValidationResult,
  type WindowReserveFloors,
} from "./types.js";

/**
 * Pure schema + referential-integrity validation for the two orchestrator
 * files (ADR 0031, Phase 1). No I/O: callers supply the already-read file
 * outcomes. Every malformed case yields at least one actionable
 * {@link ValidationIssue}; a genuinely valid pair returns `valid: true` with
 * the parsed `registry` and `policy`.
 *
 * The registry is validated independently of the policy so a broken policy
 * still surfaces registry problems, and referential integrity (every policy
 * account reference resolves to a registry account) is only checked once both
 * files parse structurally.
 */

/** The raw file outcomes handed to {@link validate}. */
export type FileInput =
  | { status: "success"; value: unknown }
  | { status: "missing" }
  | { status: "invalid"; error: string };

export function validate(
  registryInput: FileInput,
  policyInput: FileInput,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  const registry = validateRegistry(registryInput, issues);
  const policy = validatePolicy(policyInput, issues);

  if (registry && policy) {
    checkReferentialIntegrity(registry, policy, issues);
  }

  const result: ValidationResult = { valid: issues.length === 0, issues };
  if (registry) result.registry = registry;
  if (policy) result.policy = policy;
  return result;
}

function validateRegistry(
  input: FileInput,
  issues: ValidationIssue[],
): AccountRegistry | undefined {
  const root = fileRoot("registry", input, issues);
  if (!root) return undefined;

  checkSchemaVersion("registry", root, issues);

  const accountsRaw = root.accounts;
  if (!Array.isArray(accountsRaw)) {
    issues.push(
      issue(
        "registry",
        "accounts",
        "missing_field",
        "`accounts` must be a list of account objects.",
      ),
    );
    return undefined;
  }

  const accounts: RegistryAccount[] = [];
  const seenIds = new Set<string>();
  let structurallyValid = true;

  accountsRaw.forEach((raw, index) => {
    const account = validateAccount(raw, index, issues, seenIds);
    if (account) accounts.push(account);
    else structurallyValid = false;
  });

  if (!structurallyValid) return undefined;
  return { schema_version: numberOr(root.schema_version), accounts };
}

function validateAccount(
  raw: unknown,
  index: number,
  issues: ValidationIssue[],
  seenIds: Set<string>,
): RegistryAccount | undefined {
  const base = `accounts[${index}]`;
  const record = asObject(raw);
  if (!record) {
    issues.push(
      issue("registry", base, "invalid_type", `${base} must be an object.`),
    );
    return undefined;
  }

  let ok = true;
  const id = requireString("registry", record.id, `${base}.id`, issues);
  if (!id) ok = false;
  else if (seenIds.has(id)) {
    issues.push(
      issue(
        "registry",
        `${base}.id`,
        "duplicate_account_id",
        `Duplicate account id \`${id}\`. Account ids must be unique.`,
      ),
    );
    ok = false;
  } else seenIds.add(id);

  const provider = requireString(
    "registry",
    record.provider,
    `${base}.provider`,
    issues,
  );
  if (!provider) ok = false;

  const label = requireString(
    "registry",
    record.label,
    `${base}.label`,
    issues,
  );
  if (!label) ok = false;

  const costClass = requireEnum(
    "registry",
    record.cost_class,
    `${base}.cost_class`,
    ["fixed", "metered"] as const,
    issues,
  );
  if (!costClass) ok = false;

  const priorityTier = requireInteger(
    "registry",
    record.priority_tier,
    `${base}.priority_tier`,
    issues,
  );
  if (priorityTier === undefined) ok = false;

  const harnessEligibility = requireStringArray(
    "registry",
    record.harness_eligibility,
    `${base}.harness_eligibility`,
    issues,
  );
  if (!harnessEligibility) ok = false;

  const binding = requireEnum(
    "registry",
    record.binding,
    `${base}.binding`,
    ["global", "per-session"] as const,
    issues,
  );
  if (!binding) ok = false;

  const credentialStoreRef = requireString(
    "registry",
    record.credential_store_ref,
    `${base}.credential_store_ref`,
    issues,
  );
  if (!credentialStoreRef) ok = false;

  rejectCredentialMaterial(record, base, issues);

  const plan = optionalString("registry", record.plan, `${base}.plan`, issues);
  if (plan === INVALID) ok = false;

  const captainReserve = optionalReserveFloors(
    "registry",
    record.captain_reserve,
    `${base}.captain_reserve`,
    issues,
  );
  if (captainReserve === INVALID) ok = false;

  if (
    !ok ||
    !id ||
    !provider ||
    !label ||
    !costClass ||
    priorityTier === undefined ||
    !harnessEligibility ||
    !binding ||
    !credentialStoreRef
  ) {
    return undefined;
  }

  const account: RegistryAccount = {
    id,
    provider,
    label,
    cost_class: costClass,
    priority_tier: priorityTier,
    harness_eligibility: harnessEligibility,
    binding,
    credential_store_ref: credentialStoreRef,
  };
  if (typeof plan === "string") account.plan = plan;
  if (captainReserve && captainReserve !== INVALID)
    account.captain_reserve = captainReserve;
  return account;
}

function validatePolicy(
  input: FileInput,
  issues: ValidationIssue[],
): Policy | undefined {
  const root = fileRoot("policy", input, issues);
  if (!root) return undefined;

  checkSchemaVersion("policy", root, issues);

  let ok = true;

  const tiersRaw = root.tiers;
  if (!Array.isArray(tiersRaw)) {
    issues.push(
      issue(
        "policy",
        "tiers",
        "missing_field",
        "`tiers` must be a non-empty list of tier objects.",
      ),
    );
    return undefined;
  }
  if (tiersRaw.length === 0) {
    issues.push(
      issue(
        "policy",
        "tiers",
        "empty_tiers",
        "`tiers` must contain at least one tier.",
      ),
    );
    ok = false;
  }

  const tiers: PolicyTier[] = [];
  const seenTierNames = new Set<string>();
  tiersRaw.forEach((raw, index) => {
    const tier = validateTier(raw, index, issues, seenTierNames);
    if (tier) tiers.push(tier);
    else ok = false;
  });

  const captainReserve = optionalReserveFloors(
    "policy",
    root.captain_reserve,
    "captain_reserve",
    issues,
  );
  if (captainReserve === INVALID) ok = false;

  const priming = validatePriming(root.priming, issues);
  if (priming === INVALID) ok = false;

  if (root.model_map !== undefined && asObject(root.model_map) === undefined) {
    issues.push(
      issue(
        "policy",
        "model_map",
        "invalid_type",
        "`model_map` is reserved for a future phase and must be a mapping object when present.",
      ),
    );
    ok = false;
  }

  if (!ok) return undefined;

  const policy: Policy = {
    schema_version: numberOr(root.schema_version),
    tiers,
  };
  if (captainReserve && captainReserve !== INVALID)
    policy.captain_reserve = captainReserve;
  if (priming && priming !== INVALID) policy.priming = priming;
  if (root.model_map !== undefined) policy.model_map = root.model_map;
  return policy;
}

function validateTier(
  raw: unknown,
  index: number,
  issues: ValidationIssue[],
  seenNames: Set<string>,
): PolicyTier | undefined {
  const base = `tiers[${index}]`;
  const record = asObject(raw);
  if (!record) {
    issues.push(
      issue("policy", base, "invalid_type", `${base} must be an object.`),
    );
    return undefined;
  }

  let ok = true;
  const name = requireString("policy", record.name, `${base}.name`, issues);
  if (!name) ok = false;
  else if (seenNames.has(name)) {
    issues.push(
      issue(
        "policy",
        `${base}.name`,
        "duplicate_tier_name",
        `Duplicate tier name \`${name}\`. Tier names must be unique.`,
      ),
    );
    ok = false;
  } else seenNames.add(name);

  const poolsRaw = record.pools;
  if (!Array.isArray(poolsRaw) || poolsRaw.length === 0) {
    issues.push(
      issue(
        "policy",
        `${base}.pools`,
        "missing_field",
        `${base}.pools must be a non-empty list of pool objects.`,
      ),
    );
    return undefined;
  }

  const pools: PolicyPool[] = [];
  poolsRaw.forEach((poolRaw, poolIndex) => {
    const pool = validatePool(poolRaw, `${base}.pools[${poolIndex}]`, issues);
    if (pool) pools.push(pool);
    else ok = false;
  });

  if (!ok || !name) return undefined;
  return { name, pools };
}

function validatePool(
  raw: unknown,
  base: string,
  issues: ValidationIssue[],
): PolicyPool | undefined {
  const record = asObject(raw);
  if (!record) {
    issues.push(
      issue("policy", base, "invalid_type", `${base} must be an object.`),
    );
    return undefined;
  }

  let ok = true;
  const accounts = requireStringArray(
    "policy",
    record.accounts,
    `${base}.accounts`,
    issues,
  );
  if (!accounts) ok = false;
  else if (accounts.length === 0) {
    issues.push(
      issue(
        "policy",
        `${base}.accounts`,
        "empty_pool",
        `${base}.accounts must reference at least one account.`,
      ),
    );
    ok = false;
  }

  const minReserve = optionalReserveFloors(
    "policy",
    record.min_reserve,
    `${base}.min_reserve`,
    issues,
  );
  if (minReserve === INVALID) ok = false;

  if (!ok || !accounts) return undefined;
  const pool: PolicyPool = { accounts };
  if (minReserve && minReserve !== INVALID) pool.min_reserve = minReserve;
  return pool;
}

function validatePriming(
  raw: unknown,
  issues: ValidationIssue[],
): PolicyPrimingGate[] | undefined | typeof INVALID {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push(
      issue(
        "policy",
        "priming",
        "invalid_type",
        "`priming` must be a list of priming-gate objects when present.",
      ),
    );
    return INVALID;
  }

  const gates: PolicyPrimingGate[] = [];
  let ok = true;
  raw.forEach((gateRaw, index) => {
    const base = `priming[${index}]`;
    const record = asObject(gateRaw);
    if (!record) {
      issues.push(
        issue("policy", base, "invalid_type", `${base} must be an object.`),
      );
      ok = false;
      return;
    }
    const window = requireString(
      "policy",
      record.window,
      `${base}.window`,
      issues,
    );
    if (!window) ok = false;
    const threshold = requirePercent(
      "policy",
      record.resume_at_percent_remaining,
      `${base}.resume_at_percent_remaining`,
      issues,
    );
    if (threshold === undefined) ok = false;

    let accounts: string[] | undefined;
    if (record.accounts !== undefined) {
      const parsed = requireStringArray(
        "policy",
        record.accounts,
        `${base}.accounts`,
        issues,
      );
      if (!parsed) ok = false;
      else accounts = parsed;
    }

    if (window && threshold !== undefined) {
      const gate: PolicyPrimingGate = {
        window,
        resume_at_percent_remaining: threshold,
      };
      if (accounts) gate.accounts = accounts;
      gates.push(gate);
    }
  });

  return ok ? gates : INVALID;
}

function checkReferentialIntegrity(
  registry: AccountRegistry,
  policy: Policy,
  issues: ValidationIssue[],
): void {
  const known = new Set(registry.accounts.map((account) => account.id));
  policy.tiers.forEach((tier, tierIndex) => {
    tier.pools.forEach((pool, poolIndex) => {
      pool.accounts.forEach((accountId, accountIndex) => {
        if (!known.has(accountId)) {
          issues.push(
            issue(
              "policy",
              `tiers[${tierIndex}].pools[${poolIndex}].accounts[${accountIndex}]`,
              "unknown_account",
              `Policy references account \`${accountId}\`, which is not defined in the registry.`,
            ),
          );
        }
      });
    });
  });

  for (const gate of policy.priming ?? []) {
    for (const accountId of gate.accounts ?? []) {
      if (!known.has(accountId)) {
        issues.push(
          issue(
            "policy",
            "priming",
            "unknown_account",
            `Priming gate references account \`${accountId}\`, which is not defined in the registry.`,
          ),
        );
      }
    }
  }
}

// --- shared field helpers -------------------------------------------------

/** Sentinel distinguishing "absent" from "present but malformed" for optionals. */
const INVALID = Symbol("invalid");

function fileRoot(
  file: "registry" | "policy",
  input: FileInput,
  issues: ValidationIssue[],
): Record<string, unknown> | undefined {
  if (input.status === "missing") {
    issues.push(
      issue(
        file,
        "",
        "file_missing",
        `The ${file} file does not exist. Create it before validating.`,
      ),
    );
    return undefined;
  }
  if (input.status === "invalid") {
    issues.push(
      issue(
        file,
        "",
        "file_unparseable",
        `The ${file} file could not be parsed (${input.error}).`,
      ),
    );
    return undefined;
  }
  const record = asObject(input.value);
  if (!record) {
    issues.push(
      issue(
        file,
        "",
        "invalid_root",
        `The ${file} file must contain a top-level mapping.`,
      ),
    );
    return undefined;
  }
  return record;
}

function checkSchemaVersion(
  file: "registry" | "policy",
  root: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  const version = root.schema_version;
  if (version === undefined) {
    issues.push(
      issue(
        file,
        "schema_version",
        "missing_field",
        `\`schema_version\` is required. Set it to ${ORCHESTRATOR_SCHEMA_VERSION}.`,
      ),
    );
    return;
  }
  if (version !== ORCHESTRATOR_SCHEMA_VERSION) {
    issues.push(
      issue(
        file,
        "schema_version",
        "unsupported_schema_version",
        `Unsupported \`schema_version\` ${JSON.stringify(version)}. This build understands ${ORCHESTRATOR_SCHEMA_VERSION}.`,
      ),
    );
  }
}

function rejectCredentialMaterial(
  record: Record<string, unknown>,
  base: string,
  issues: ValidationIssue[],
): void {
  for (const forbidden of [
    "credential",
    "credentials",
    "api_key",
    "apiKey",
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "password",
  ]) {
    if (forbidden in record) {
      issues.push(
        issue(
          "registry",
          `${base}.${forbidden}`,
          "credential_material_forbidden",
          `The registry must never store credentials. Remove \`${forbidden}\` and use \`credential_store_ref\` instead.`,
        ),
      );
    }
  }
}

function requireString(
  file: "registry" | "policy",
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  issues.push(
    issue(
      file,
      path,
      value === undefined ? "missing_field" : "invalid_type",
      `${path} must be a non-empty string.`,
    ),
  );
  return undefined;
}

function optionalString(
  file: "registry" | "policy",
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value;
  issues.push(
    issue(file, path, "invalid_type", `${path} must be a non-empty string.`),
  );
  return INVALID;
}

function requireStringArray(
  file: "registry" | "policy",
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string[] | undefined {
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    return value as string[];
  }
  issues.push(
    issue(
      file,
      path,
      value === undefined ? "missing_field" : "invalid_type",
      `${path} must be a list of non-empty strings.`,
    ),
  );
  return undefined;
}

function requireInteger(
  file: "registry" | "policy",
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  issues.push(
    issue(
      file,
      path,
      value === undefined ? "missing_field" : "invalid_type",
      `${path} must be an integer.`,
    ),
  );
  return undefined;
}

function requirePercent(
  file: "registry" | "policy",
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  ) {
    return value;
  }
  issues.push(
    issue(
      file,
      path,
      value === undefined ? "missing_field" : "invalid_type",
      `${path} must be a number between 0 and 100.`,
    ),
  );
  return undefined;
}

function requireEnum<const T extends readonly string[]>(
  file: "registry" | "policy",
  value: unknown,
  path: string,
  allowed: T,
  issues: ValidationIssue[],
): T[number] | undefined {
  if (typeof value === "string" && allowed.includes(value)) {
    return value as T[number];
  }
  issues.push(
    issue(
      file,
      path,
      value === undefined ? "missing_field" : "invalid_value",
      `${path} must be one of: ${allowed.join(", ")}.`,
    ),
  );
  return undefined;
}

function optionalReserveFloors(
  file: "registry" | "policy",
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WindowReserveFloors | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  const record = asObject(value);
  if (!record) {
    issues.push(
      issue(
        file,
        path,
        "invalid_type",
        `${path} must be a mapping of window id to a reserve percent.`,
      ),
    );
    return INVALID;
  }
  const floors: WindowReserveFloors = {};
  let ok = true;
  for (const [windowId, raw] of Object.entries(record)) {
    if (
      typeof raw === "number" &&
      Number.isFinite(raw) &&
      raw >= 0 &&
      raw <= 100
    ) {
      floors[windowId] = raw;
    } else {
      issues.push(
        issue(
          file,
          `${path}.${windowId}`,
          "invalid_value",
          `${path}.${windowId} must be a reserve percent between 0 and 100.`,
        ),
      );
      ok = false;
    }
  }
  return ok ? floors : INVALID;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOr(value: unknown): number {
  return typeof value === "number" ? value : ORCHESTRATOR_SCHEMA_VERSION;
}

function issue(
  file: "registry" | "policy",
  path: string,
  code: string,
  message: string,
): ValidationIssue {
  return { file, path, code, message };
}

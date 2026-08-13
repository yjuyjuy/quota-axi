/**
 * Account-switch orchestrator, Phase 1 (ADR 0031): the two captain-editable
 * files quota-axi owns and their validation contract.
 *
 * quota-axi remains data-only. These types describe declarative inputs a
 * captain or external agent authors; the mutating account-switch decider and
 * the `switch` verb are separate later tickets. Nothing here routes, mutates,
 * or spends provider quota.
 *
 * Limits are observation-driven: `plan` is informational only and is never
 * used for arithmetic anywhere in the orchestrator.
 */

/** Current schema version for both files. Bump only on a breaking change. */
export const ORCHESTRATOR_SCHEMA_VERSION = 1;

/** How an account's cost accrues. Informs the decider, never arithmetic here. */
export type AccountCostClass = "fixed" | "metered";

/**
 * Whether an account's quota is shared across every session (`global`) or is
 * scoped to a single session/seat (`per-session`).
 */
export type AccountBinding = "global" | "per-session";

/**
 * Per-window reserve floors, keyed by quota window id (for example
 * `seven_day`, `five_hour`, `model:fable`). Each value is a percent of the
 * window that must remain unused (0-100). Used for both an account's optional
 * owner reserve and the policy-level captain reserve.
 */
export type WindowReserveFloors = Record<string, number>;

/**
 * One account in the registry. Credentials are NEVER stored here: only
 * `credential_store_ref`, an opaque pointer resolved elsewhere.
 */
export type RegistryAccount = {
  /** Stable identifier referenced by the policy file. */
  id: string;
  /** Provider slug, for example `claude`. Provider-general by design. */
  provider: string;
  /** Human-facing label. */
  label: string;
  /** Informational plan name (Pro, Max, Team seat, ...). Never arithmetic. */
  plan?: string;
  cost_class: AccountCostClass;
  /** Lower numbers bind first. Ties are broken by the policy ordering. */
  priority_tier: number;
  /** Harness ids this account may serve, for example `["jcode"]`. */
  harness_eligibility: string[];
  binding: AccountBinding;
  /** Opaque pointer into the credential store. NEVER a credential value. */
  credential_store_ref: string;
  /** Optional owner-set reserve floors for this account. */
  captain_reserve?: WindowReserveFloors;
};

/** The account registry file (captain-editable). */
export type AccountRegistry = {
  schema_version: number;
  accounts: RegistryAccount[];
};

/**
 * One pool of interchangeable accounts inside a tier. Accounts are referenced
 * by registry id; referential integrity is enforced by validation.
 */
export type PolicyPool = {
  /** Registry account ids that make up this pool. */
  accounts: string[];
  /** Optional per-window reserve floors applied to this pool. */
  min_reserve?: WindowReserveFloors;
};

/** One ordered tier of account pools. Earlier tiers are preferred. */
export type PolicyTier = {
  name: string;
  pools: PolicyPool[];
};

/**
 * A priming gate: a recovery threshold that keeps a cooled-down account out of
 * selection until the named window recovers to `resume_at_percent_remaining`.
 * Declarative only; the decider interprets it.
 */
export type PolicyPrimingGate = {
  /** Quota window id the gate watches, for example `seven_day`. */
  window: string;
  /** Remaining-percent threshold (0-100) at which the account may resume. */
  resume_at_percent_remaining: number;
  /** Optional account ids the gate applies to; omitted means all accounts. */
  accounts?: string[];
};

/**
 * The declarative policy file (captain/agent-editable). The Phase 2 model map
 * slots in additively as an optional `model_map` field without breaking this
 * schema; it is intentionally NOT built in Phase 1.
 */
export type Policy = {
  schema_version: number;
  /** Ordered tiers of account pools; earlier tiers are preferred. */
  tiers: PolicyTier[];
  /** Policy-level captain reserve floors, keyed by window id. */
  captain_reserve?: WindowReserveFloors;
  /** Priming gates evaluated by the decider. */
  priming?: PolicyPrimingGate[];
  /**
   * Reserved for Phase 2 (per-provider model equivalents plus a required
   * default model per provider). Present here only so the field name is
   * claimed; Phase 1 neither builds nor validates its contents beyond
   * rejecting an obviously non-object value.
   */
  model_map?: unknown;
};

/** A single actionable validation problem. */
export type ValidationIssue = {
  /** Which file the problem is in. */
  file: "registry" | "policy";
  /** Dotted/indexed path to the offending value, for example
   * `accounts[1].cost_class` or `tiers[0].pools[0].accounts[2]`. */
  path: string;
  /** Stable machine code, for example `missing_field` or `unknown_account`. */
  code: string;
  /** Actionable, human-readable message. */
  message: string;
};

/** The outcome of validating a registry/policy pair. */
export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  /** The parsed registry, present only when the registry itself is valid. */
  registry?: AccountRegistry;
  /** The parsed policy, present only when the policy itself is valid. */
  policy?: Policy;
};

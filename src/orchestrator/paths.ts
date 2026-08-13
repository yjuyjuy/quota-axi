import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config and last-valid-fallback file locations for the account-switch
 * orchestrator (ADR 0031, Phase 1).
 *
 * The two captain-editable files live in the orchestrator config directory,
 * separate from the read-only quota cache. Env overrides exist so a captain
 * or a test can point at an alternate layout without touching $HOME.
 *
 * Precedence for the config directory:
 *   1. $QUOTA_AXI_CONFIG_HOME (explicit override)
 *   2. $XDG_CONFIG_HOME/quota-axi
 *   3. ~/.config/quota-axi
 *
 * Individual files can be overridden directly with $QUOTA_AXI_REGISTRY and
 * $QUOTA_AXI_POLICY, mirroring how the providers accept per-source path
 * overrides.
 */

export function orchestratorConfigDir(): string {
  const explicit = process.env.QUOTA_AXI_CONFIG_HOME;
  if (explicit) return explicit;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "quota-axi");
}

export function registryFilePath(): string {
  return (
    process.env.QUOTA_AXI_REGISTRY ||
    join(orchestratorConfigDir(), "accounts.yaml")
  );
}

export function policyFilePath(): string {
  return (
    process.env.QUOTA_AXI_POLICY || join(orchestratorConfigDir(), "policy.yaml")
  );
}

/**
 * The persisted last-valid policy snapshot. It lives under the cache directory
 * (not the config directory) because it is derived state quota-axi owns, not a
 * captain-edited input. A bad edit to `policy.yaml` never overwrites this file,
 * so it is always available as the mechanical fallback.
 */
export function lastValidPolicyPath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "quota-axi", "last-valid-policy.json");
}

import {
  chmodSync,
  mkdirSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import {
  lastValidPolicyPath,
  policyFilePath,
  registryFilePath,
} from "./paths.js";
import { ORCHESTRATOR_SCHEMA_VERSION, type Policy } from "./types.js";
import { validate } from "./validate.js";
import { readYamlFile } from "./yaml.js";

/**
 * Loads, validates, and hot-reloads the account registry + declarative policy
 * (ADR 0031, Phase 1).
 *
 * The last valid policy is always retained as the mechanical fallback, in two
 * layers:
 *   - in-memory: {@link PolicyStore.current} keeps the most recent valid policy
 *     for the life of the process, so a bad edit never blanks the live value.
 *   - persisted: {@link lastValidPolicyPath} snapshots that policy to disk, so
 *     the fallback survives a restart. A bad edit never overwrites it.
 *
 * The store performs no routing and mutates no provider state. It reads the two
 * captain-edited files and writes only the derived last-valid snapshot.
 */

export type PolicyReloadResult = {
  ok: boolean;
  /** The policy now in effect (freshly valid, or the retained fallback). */
  policy?: Policy;
  /** True when `policy` is the retained fallback rather than the new edit. */
  usedFallback: boolean;
  /** Validation issues from the attempted load, empty when it was valid. */
  issues: ReturnType<typeof validate>["issues"];
};

export type PolicyStoreOptions = {
  registryPath?: string;
  policyPath?: string;
  snapshotPath?: string;
  /** Called after every reload (including the initial load). */
  onReload?: (result: PolicyReloadResult) => void;
};

export class PolicyStore {
  private readonly registryPath: string;
  private readonly policyPath: string;
  private readonly snapshotPath: string;
  private readonly onReload: ((result: PolicyReloadResult) => void) | undefined;
  private inMemory: Policy | undefined;
  private watchers: FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PolicyStoreOptions = {}) {
    this.registryPath = options.registryPath ?? registryFilePath();
    this.policyPath = options.policyPath ?? policyFilePath();
    this.snapshotPath = options.snapshotPath ?? lastValidPolicyPath();
    this.onReload = options.onReload;
  }

  /** The policy currently in effect: last valid load, or persisted fallback. */
  get current(): Policy | undefined {
    return this.inMemory ?? this.readSnapshot();
  }

  /**
   * Read + validate both files once. On success the valid policy becomes the
   * new in-memory value and is snapshotted. On failure the retained fallback
   * (in-memory, else persisted snapshot) stays in effect and is returned.
   */
  reload(): PolicyReloadResult {
    const registryInput = readYamlFile(this.registryPath);
    const policyInput = readYamlFile(this.policyPath);
    const result = validate(registryInput, policyInput);

    if (result.valid && result.policy) {
      this.inMemory = result.policy;
      this.writeSnapshot(result.policy);
      const reload: PolicyReloadResult = {
        ok: true,
        policy: result.policy,
        usedFallback: false,
        issues: [],
      };
      this.onReload?.(reload);
      return reload;
    }

    const fallback = this.current;
    const reload: PolicyReloadResult = {
      ok: false,
      usedFallback: fallback !== undefined,
      issues: result.issues,
      ...(fallback ? { policy: fallback } : {}),
    };
    this.onReload?.(reload);
    return reload;
  }

  /**
   * Begin watching both files for edits and reload on change. Debounced so a
   * multi-event save is applied once. Returns the initial reload result.
   */
  start(): PolicyReloadResult {
    const initial = this.reload();
    for (const path of [this.registryPath, this.policyPath]) {
      try {
        this.watchers.push(
          watch(path, { persistent: false }, () => this.scheduleReload()),
        );
      } catch {
        // A missing file cannot be watched yet; reload() already reported it.
      }
    }
    return initial;
  }

  /** Stop watching. Idempotent. */
  stop(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private scheduleReload(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.reload();
    }, 50);
  }

  private readSnapshot(): Policy | undefined {
    const result = readJsonFileResult(this.snapshotPath);
    if (result.status !== "success") return undefined;
    const record = result.value;
    if (
      record !== null &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      (record as { schema_version?: unknown }).schema_version ===
        ORCHESTRATOR_SCHEMA_VERSION
    ) {
      return record as Policy;
    }
    return undefined;
  }

  private writeSnapshot(policy: Policy): void {
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true, mode: 0o700 });
      const temp = `${this.snapshotPath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(policy, null, 2)}\n`, {
        mode: 0o600,
      });
      chmodSync(temp, 0o600);
      renameSync(temp, this.snapshotPath);
      chmodSync(this.snapshotPath, 0o600);
    } catch {
      // Best effort: an unwritable snapshot never blocks the in-memory policy.
    }
  }
}

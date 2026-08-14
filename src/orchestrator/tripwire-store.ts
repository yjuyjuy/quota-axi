import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { tripwireStorePath } from "./paths.js";

/**
 * The recorded tripwire store (ADR 0031, Phase 1): durable "account exhausted
 * until T" state the mutating `switch` verb writes when it rotates off an
 * exhausted or crossed-reserve account, and that a later `decide` run reads
 * back so a tripped account stays out of selection until its recovery deadline.
 *
 * `switch` is the ONLY writer in the whole orchestrator, and this store is the
 * only durable state it records besides driving the jcode live-session surface.
 * `decide` never touches this file; the `switch` command layer reads it here and
 * folds the recorded deadlines into the observations it feeds the pure decider,
 * mirroring the account observation's `exhaustedUntil` field.
 *
 * Persistence follows the same atomic-write convention as {@link PolicyStore}:
 * a `0600` temp file written under a `0700` parent, then renamed into place so a
 * concurrent reader never sees a partial write. An unwritable store is a hard
 * error here (unlike the best-effort policy snapshot) because a silently dropped
 * tripwire would let an exhausted account be reselected immediately, which is
 * the exact failure this store exists to prevent.
 */

/** Current tripwire store schema version. Bump only on a breaking change. */
export const TRIPWIRE_SCHEMA_VERSION = 1;

/** One recorded tripwire: an account is exhausted until `exhaustedUntil`. */
export type TripwireRecord = {
  /** ISO time until which the account is treated as exhausted. */
  exhaustedUntil: string;
  /** ISO time the tripwire was recorded, for auditing. */
  recordedAt: string;
  /** Optional machine reason the tripwire was recorded. */
  reason?: string;
};

/** The on-disk tripwire store shape. */
export type TripwireStoreFile = {
  schemaVersion: typeof TRIPWIRE_SCHEMA_VERSION;
  /** Recorded tripwires keyed by registry account id. */
  tripwires: Record<string, TripwireRecord>;
};

export type TripwireStoreOptions = {
  /** Store file path; defaults to {@link tripwireStorePath}. */
  path?: string;
};

export class TripwireStore {
  private readonly path: string;

  constructor(options: TripwireStoreOptions = {}) {
    this.path = options.path ?? tripwireStorePath();
  }

  /** The store file path in effect. */
  get filePath(): string {
    return this.path;
  }

  /**
   * Read the recorded tripwires. A missing or unreadable store is an empty map
   * (no recorded tripwires), never an error: absence just means nothing has
   * been tripped yet.
   */
  read(): Record<string, TripwireRecord> {
    const result = readJsonFileResult(this.path);
    if (result.status !== "success") return {};
    const value = result.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const record = value as { tripwires?: unknown };
    const tripwires = record.tripwires;
    if (
      tripwires === null ||
      typeof tripwires !== "object" ||
      Array.isArray(tripwires)
    ) {
      return {};
    }
    const out: Record<string, TripwireRecord> = {};
    for (const [account, entry] of Object.entries(
      tripwires as Record<string, unknown>,
    )) {
      const parsed = parseRecord(entry);
      if (parsed) out[account] = parsed;
    }
    return out;
  }

  /**
   * Record tripwires for the given accounts, merging into any existing store so
   * a per-scope switch never clobbers an unrelated account's recorded deadline.
   * A later record for the same account overwrites the earlier one. Returns the
   * full merged map now persisted.
   */
  record(
    updates: Record<string, TripwireRecord>,
  ): Record<string, TripwireRecord> {
    const merged = { ...this.read(), ...updates };
    this.write(merged);
    return merged;
  }

  private write(tripwires: Record<string, TripwireRecord>): void {
    const file: TripwireStoreFile = {
      schemaVersion: TRIPWIRE_SCHEMA_VERSION,
      tripwires,
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
  }
}

function parseRecord(value: unknown): TripwireRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.exhaustedUntil !== "string") return undefined;
  const out: TripwireRecord = {
    exhaustedUntil: record.exhaustedUntil,
    recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : "",
  };
  if (typeof record.reason === "string") out.reason = record.reason;
  return out;
}

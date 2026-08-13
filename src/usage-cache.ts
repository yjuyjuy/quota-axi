import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  readJsonFile,
  usageCacheLockPath,
  usageCacheRecordPath,
} from "./lib/fs.js";
import type { ProviderQuota, UsageCacheMarker } from "./types.js";

/**
 * Shared on-disk single-flight usage cache (ADR 0031, Phase 1).
 *
 * The whole host makes about one upstream usage fetch per provider per TTL.
 * Concurrent callers (any jcode session, any quota-axi invocation) coalesce
 * onto ONE in-flight fetch through a cross-process lock file, then reuse the
 * result the winner wrote instead of each firing their own request. This is the
 * layer that fixes the N-independent-poller 429 storm on provider usage
 * endpoints.
 *
 * The cache is read-path only: its sole side effects are its own record and
 * lock files. It never routes, mutates provider state, or retains raw provider
 * responses; the stored payload is the same normalized, non-secret
 * {@link ProviderQuota} the fetch layer already produces, minus account
 * identity and per-source attempts.
 */

const SCHEMA_VERSION = 1;

export type UsageCacheConfig = {
  /** Serve a stored payload without an upstream fetch below this age. */
  ttlSeconds: number;
  /** First-attempt backoff floor when a 429 omits Retry-After. */
  backoffBaseSeconds: number;
  /** Exponential backoff ceiling across consecutive 429s. */
  backoffCapSeconds: number;
  /** How long a waiter blocks for the lock holder before giving up. */
  waitTimeoutMs: number;
  /** Poll cadence while a waiter blocks for the lock holder. */
  pollIntervalMs: number;
  /** A lock older than this is treated as abandoned and stolen. */
  lockStaleMs: number;
  /** Age at or above which a served payload is only partially trusted. */
  agingSeconds: number;
  /** Age at or above which a served payload is treated as unknown. */
  unknownSeconds: number;
};

export const DEFAULT_USAGE_CACHE_CONFIG: UsageCacheConfig = {
  ttlSeconds: 300,
  backoffBaseSeconds: 900,
  backoffCapSeconds: 3_600,
  waitTimeoutMs: 20_000,
  pollIntervalMs: 50,
  lockStaleMs: 30_000,
  agingSeconds: 600,
  unknownSeconds: 3_600,
};

export type UsageCacheRecord = {
  schemaVersion: number;
  key: string;
  /** ISO timestamp of the fetch that produced {@link payload}. */
  fetchedAt: string;
  /** Last fresh normalized provider snapshot, or undefined before one exists. */
  payload?: ProviderQuota;
  /** Server-specified Retry-After deadline (ISO), when the 429 carried one. */
  retryAfter?: string;
  /** Deadline (ISO) before which no caller re-fetches after a 429. */
  backoffUntil?: string;
  /** Consecutive 429 count driving exponential backoff. */
  backoffAttempts?: number;
};

/** Filesystem, clock, and randomness seam so the coalescing logic is testable. */
export type UsageCacheIo = {
  now(): number;
  random(): number;
  sleep(ms: number): Promise<void>;
  readRecord(path: string): UsageCacheRecord | undefined;
  writeRecord(path: string, record: UsageCacheRecord): void;
  /** Atomically create the lock; false when another holder already owns it. */
  tryAcquireLock(path: string, holder: string): boolean;
  /** Age of the lock in milliseconds, or undefined when no lock exists. */
  lockAgeMs(path: string, now: number): number | undefined;
  releaseLock(path: string): void;
};

export type UsageCacheOptions = {
  config?: Partial<UsageCacheConfig>;
  io?: UsageCacheIo;
};

/**
 * Read a provider's usage through the shared cache, fetching upstream at most
 * once per TTL across the whole host and coalescing concurrent callers onto a
 * single in-flight fetch. The returned {@link ProviderQuota} carries a
 * {@link UsageCacheMarker} on `state.usageCache` describing its provenance and
 * age so consumers can age-degrade trust.
 */
export async function readThroughUsageCache(
  key: string,
  fetchQuota: () => Promise<ProviderQuota>,
  options: UsageCacheOptions = {},
): Promise<ProviderQuota> {
  const config = { ...DEFAULT_USAGE_CACHE_CONFIG, ...options.config };
  const io = options.io ?? defaultUsageCacheIo;
  const recordPath = usageCacheRecordPath(key);
  const lockPath = usageCacheLockPath(key);

  const record = io.readRecord(recordPath);

  // A stored payload inside the TTL is served with no upstream fetch at all.
  if (record?.payload && withinTtl(record, config, io.now())) {
    return served(record, config, io.now());
  }
  // While a 429 backoff is in force, serve the last payload instead of
  // re-fetching, so a rate limit never becomes a retry storm.
  if (record?.payload && inBackoff(record, io.now())) {
    return served(record, config, io.now());
  }

  if (io.tryAcquireLock(lockPath, holderTag())) {
    try {
      // Another caller may have refreshed between our read and the lock.
      const latest = io.readRecord(recordPath);
      if (
        latest?.payload &&
        (withinTtl(latest, config, io.now()) || inBackoff(latest, io.now()))
      ) {
        return served(latest, config, io.now());
      }
      return await fetchAndStore(
        key,
        fetchQuota,
        recordPath,
        latest ?? record,
        config,
        io,
      );
    } finally {
      io.releaseLock(lockPath);
    }
  }

  // Another caller holds the lock: wait for the in-flight fetch it is running
  // and reuse whatever it writes, rather than firing our own request.
  return waitForHolder(
    key,
    fetchQuota,
    recordPath,
    lockPath,
    record,
    config,
    io,
  );
}

async function fetchAndStore(
  key: string,
  fetchQuota: () => Promise<ProviderQuota>,
  recordPath: string,
  previous: UsageCacheRecord | undefined,
  config: UsageCacheConfig,
  io: UsageCacheIo,
): Promise<ProviderQuota> {
  const quota = await fetchQuota();
  const now = io.now();

  if (isRateLimited(quota)) {
    const updated = recordAfterRateLimit(key, quota, previous, config, io, now);
    io.writeRecord(recordPath, updated);
    if (updated.payload) return served(updated, config, now);
    // Nothing to serve yet: pass the rate-limited result through unchanged.
    return quota;
  }

  if (quota.state.status === "fresh" && quota.windows.length > 0) {
    const record: UsageCacheRecord = {
      schemaVersion: SCHEMA_VERSION,
      key,
      fetchedAt: new Date(now).toISOString(),
      payload: sanitizePayload(quota),
    };
    io.writeRecord(recordPath, record);
    return withMarker(quota, {
      fetchedAt: record.fetchedAt,
      ageSeconds: 0,
      trust: "fresh",
      servedFromCache: false,
    });
  }

  // Non-fresh, non-429 results (auth_required, error, provider-served stale)
  // are passed straight through: they are not a retry-storm risk and must not
  // overwrite a good stored payload.
  return quota;
}

function recordAfterRateLimit(
  key: string,
  quota: ProviderQuota,
  previous: UsageCacheRecord | undefined,
  config: UsageCacheConfig,
  io: UsageCacheIo,
  now: number,
): UsageCacheRecord {
  const attempts = (previous?.backoffAttempts ?? 0) + 1;
  const serverRetryAfter = quota.state.retryAfter;
  const backoffUntil =
    serverRetryAfter ??
    new Date(now + backoffMillis(attempts, config, io.random())).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    key,
    fetchedAt: previous?.fetchedAt ?? new Date(now).toISOString(),
    ...(previous?.payload ? { payload: previous.payload } : {}),
    ...(serverRetryAfter ? { retryAfter: serverRetryAfter } : {}),
    backoffUntil,
    backoffAttempts: attempts,
  };
}

async function waitForHolder(
  key: string,
  fetchQuota: () => Promise<ProviderQuota>,
  recordPath: string,
  lockPath: string,
  before: UsageCacheRecord | undefined,
  config: UsageCacheConfig,
  io: UsageCacheIo,
): Promise<ProviderQuota> {
  const deadline = io.now() + config.waitTimeoutMs;
  const beforeStamp = before?.fetchedAt;
  const beforeBackoff = before?.backoffUntil;

  while (io.now() < deadline) {
    await io.sleep(config.pollIntervalMs);
    const current = io.readRecord(recordPath);
    if (
      current?.payload &&
      (current.fetchedAt !== beforeStamp ||
        current.backoffUntil !== beforeBackoff) &&
      (withinTtl(current, config, io.now()) || inBackoff(current, io.now()))
    ) {
      return served(current, config, io.now());
    }
    // The holder finished (released the lock) but produced no servable payload,
    // for example an auth failure: take the lock ourselves and fetch.
    const lockAge = io.lockAgeMs(lockPath, io.now());
    if (lockAge === undefined && io.tryAcquireLock(lockPath, holderTag())) {
      try {
        return await fetchAndStore(
          key,
          fetchQuota,
          recordPath,
          io.readRecord(recordPath) ?? before,
          config,
          io,
        );
      } finally {
        io.releaseLock(lockPath);
      }
    }
    // Steal a lock left behind by a crashed holder so no one wedges forever.
    if (lockAge !== undefined && lockAge > config.lockStaleMs) {
      io.releaseLock(lockPath);
    }
  }

  // Timed out waiting. Serve the last stored payload if there is one; otherwise
  // fall back to a direct fetch rather than returning nothing.
  const current = io.readRecord(recordPath);
  if (current?.payload) return served(current, config, io.now());
  return fetchAndStore(
    key,
    fetchQuota,
    recordPath,
    current ?? before,
    config,
    io,
  );
}

function served(
  record: UsageCacheRecord,
  config: UsageCacheConfig,
  now: number,
): ProviderQuota {
  const payload = record.payload;
  if (!payload) throw new Error("usage cache served an empty record");
  const ageSeconds = Math.max(
    0,
    Math.round((now - Date.parse(record.fetchedAt)) / 1000),
  );
  return withMarker(payload, {
    fetchedAt: record.fetchedAt,
    ageSeconds,
    trust: trustForAge(ageSeconds, config),
    servedFromCache: true,
  });
}

export function trustForAge(
  ageSeconds: number,
  config: UsageCacheConfig = DEFAULT_USAGE_CACHE_CONFIG,
): UsageCacheMarker["trust"] {
  if (ageSeconds >= config.unknownSeconds) return "unknown";
  if (ageSeconds >= config.agingSeconds) return "aging";
  return "fresh";
}

/**
 * Backoff for a consecutive-429 count with equal jitter: half the exponential
 * base plus a random half, keeping the default first backoff near 15 minutes
 * while spreading retries so callers do not resynchronize into a fresh storm.
 */
export function backoffMillis(
  attempts: number,
  config: UsageCacheConfig,
  random: number,
): number {
  const exponent = Math.max(0, attempts - 1);
  const baseSeconds = Math.min(
    config.backoffCapSeconds,
    config.backoffBaseSeconds * 2 ** exponent,
  );
  const half = baseSeconds / 2;
  const jittered = half + clampUnit(random) * half;
  return Math.round(jittered * 1000);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function withinTtl(
  record: UsageCacheRecord,
  config: UsageCacheConfig,
  now: number,
): boolean {
  const fetchedAt = Date.parse(record.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  return now - fetchedAt < config.ttlSeconds * 1000;
}

function inBackoff(record: UsageCacheRecord, now: number): boolean {
  if (!record.backoffUntil) return false;
  const until = Date.parse(record.backoffUntil);
  return Number.isFinite(until) && until > now;
}

function isRateLimited(quota: ProviderQuota): boolean {
  return quota.state.status === "rate_limited";
}

function withMarker(
  quota: ProviderQuota,
  marker: UsageCacheMarker,
): ProviderQuota {
  return { ...quota, state: { ...quota.state, usageCache: marker } };
}

/** Store only the normalized, non-identity snapshot the cache is allowed to hold. */
function sanitizePayload(quota: ProviderQuota): ProviderQuota {
  const state = { ...quota.state };
  delete state.usageCache;
  const payload: ProviderQuota = { ...quota, state };
  delete payload.account;
  delete payload.attempts;
  return payload;
}

function holderTag(): string {
  return `${process.pid}:${Date.now()}`;
}

export const defaultUsageCacheIo: UsageCacheIo = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readRecord(path) {
    const raw = readJsonFile(path);
    return normalizeRecord(raw);
  },
  writeRecord(path, record) {
    ensureUsageDir(path);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  },
  tryAcquireLock(path, holder) {
    ensureUsageDir(path);
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch {
      return false;
    }
    try {
      writeSync(fd, holder);
    } catch {
      // A written holder tag is advisory only; the lock still holds.
    } finally {
      closeSync(fd);
    }
    return true;
  },
  lockAgeMs(path, now) {
    try {
      return Math.max(0, now - statSync(path).mtimeMs);
    } catch {
      return undefined;
    }
  },
  releaseLock(path) {
    try {
      unlinkSync(path);
    } catch {
      // Already released or stolen; nothing to undo.
    }
  },
};

function ensureUsageDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function normalizeRecord(raw: unknown): UsageCacheRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof data.key !== "string" || typeof data.fetchedAt !== "string") {
    return undefined;
  }
  const record: UsageCacheRecord = {
    schemaVersion: SCHEMA_VERSION,
    key: data.key,
    fetchedAt: data.fetchedAt,
  };
  if (data.payload && typeof data.payload === "object") {
    record.payload = data.payload as ProviderQuota;
  }
  if (typeof data.retryAfter === "string") record.retryAfter = data.retryAfter;
  if (typeof data.backoffUntil === "string") {
    record.backoffUntil = data.backoffUntil;
  }
  if (typeof data.backoffAttempts === "number") {
    record.backoffAttempts = data.backoffAttempts;
  }
  return record;
}

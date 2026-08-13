import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { usageCacheLockPath, usageCacheRecordPath } from "../src/lib/fs.js";
import {
  backoffMillis,
  DEFAULT_USAGE_CACHE_CONFIG,
  defaultUsageCacheIo,
  readThroughUsageCache,
  trustForAge,
  type UsageCacheIo,
  type UsageCacheRecord,
} from "../src/usage-cache.js";
import type { ProviderQuota } from "../src/types.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("shared usage cache single-flight", () => {
  it("coalesces concurrent callers into exactly one upstream fetch", async () => {
    const io = fakeIo();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      await io.sleep(5);
      return freshQuota("claude", 10);
    };

    const results = await Promise.all([
      readThroughUsageCache("claude", fetch, { io }),
      readThroughUsageCache("claude", fetch, { io }),
      readThroughUsageCache("claude", fetch, { io }),
      readThroughUsageCache("claude", fetch, { io }),
    ]);

    expect(fetches).toBe(1);
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.provider).toBe("claude");
      expect(result.windows[0].percentUsed).toBe(10);
    }
    // Exactly one caller performed the fetch; the rest served from cache.
    expect(
      results.filter((result) => result.state.usageCache?.servedFromCache),
    ).toHaveLength(3);
    expect(
      results.filter(
        (result) => result.state.usageCache?.servedFromCache === false,
      ),
    ).toHaveLength(1);
  });

  it("serves a stored payload within the TTL without re-fetching", async () => {
    const io = fakeIo();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return freshQuota("codex", 25);
    };

    await readThroughUsageCache("codex", fetch, { io });
    io.advance(60_000); // still inside the 300s TTL
    const second = await readThroughUsageCache("codex", fetch, { io });

    expect(fetches).toBe(1);
    expect(second.state.usageCache?.servedFromCache).toBe(true);
    expect(second.state.usageCache?.ageSeconds).toBe(60);
  });

  it("re-fetches once the TTL elapses", async () => {
    const io = fakeIo();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return freshQuota("codex", 30 + fetches);
    };

    await readThroughUsageCache("codex", fetch, { io });
    io.advance(DEFAULT_USAGE_CACHE_CONFIG.ttlSeconds * 1000 + 1);
    const second = await readThroughUsageCache("codex", fetch, { io });

    expect(fetches).toBe(2);
    expect(second.state.usageCache?.servedFromCache).toBe(false);
  });
});

describe("shared usage cache 429 handling", () => {
  it("serves cache during backoff and never produces a retry storm", async () => {
    const io = fakeIo();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      if (fetches === 1) return freshQuota("claude", 15);
      return rateLimitedQuota("claude");
    };

    // Prime the cache with a good payload.
    await readThroughUsageCache("claude", fetch, { io });
    // Expire the TTL so the next call attempts a fetch, which 429s.
    io.advance(DEFAULT_USAGE_CACHE_CONFIG.ttlSeconds * 1000 + 1);
    const rateLimited = await readThroughUsageCache("claude", fetch, { io });
    expect(fetches).toBe(2);
    expect(rateLimited.state.usageCache?.servedFromCache).toBe(true);
    expect(rateLimited.windows[0].percentUsed).toBe(15);

    // Many callers during the backoff window fire zero further upstream fetches.
    io.advance(1_000);
    for (let index = 0; index < 25; index++) {
      const served = await readThroughUsageCache("claude", fetch, { io });
      expect(served.windows[0].percentUsed).toBe(15);
    }
    expect(fetches).toBe(2);
  });

  it("honors a server Retry-After deadline over computed backoff", async () => {
    const io = fakeIo();
    let fetches = 0;
    let retryAfter = "";
    const fetch = async () => {
      fetches++;
      if (fetches === 1) return freshQuota("claude", 5);
      retryAfter = new Date(io.now() + 42_000).toISOString();
      return {
        ...rateLimitedQuota("claude"),
        state: {
          ...rateLimitedQuota("claude").state,
          retryAfter,
        },
      };
    };

    await readThroughUsageCache("claude", fetch, { io });
    io.advance(DEFAULT_USAGE_CACHE_CONFIG.ttlSeconds * 1000 + 1);
    await readThroughUsageCache("claude", fetch, { io });

    const record = io.readRecord(usageCacheRecordPath("claude"));
    expect(record?.retryAfter).toBe(retryAfter);
    expect(record?.backoffUntil).toBe(retryAfter);

    // Just before the deadline, still served from cache; no fetch.
    io.advance(40_000);
    await readThroughUsageCache("claude", fetch, { io });
    expect(fetches).toBe(2);

    // After the deadline, exactly one fetch happens.
    io.advance(5_000);
    await readThroughUsageCache("claude", fetch, { io });
    expect(fetches).toBe(3);
  });

  it("grows backoff exponentially and applies bounded equal jitter", () => {
    const config = DEFAULT_USAGE_CACHE_CONFIG;
    // random=0 gives the exponential floor (half the base); random=1 the ceiling.
    expect(backoffMillis(1, config, 0)).toBe(450_000);
    expect(backoffMillis(1, config, 1)).toBe(900_000);
    // Second attempt doubles the base, capped by backoffCapSeconds.
    expect(backoffMillis(2, config, 0)).toBe(900_000);
    expect(backoffMillis(2, config, 1)).toBe(1_800_000);
    // The cap holds no matter how many attempts accumulate.
    expect(backoffMillis(10, config, 1)).toBe(config.backoffCapSeconds * 1000);
    // Jitter stays within the [half, base] band for a mid-range draw.
    expect(backoffMillis(1, config, 0.5)).toBeGreaterThanOrEqual(450_000);
    expect(backoffMillis(1, config, 0.5)).toBeLessThanOrEqual(900_000);
  });
});

describe("shared usage cache age markers", () => {
  it("classifies trust by age tier", () => {
    expect(trustForAge(0)).toBe("fresh");
    expect(trustForAge(599)).toBe("fresh");
    expect(trustForAge(600)).toBe("aging");
    expect(trustForAge(3_599)).toBe("aging");
    expect(trustForAge(3_600)).toBe("unknown");
  });

  it("ages a served marker across trust tiers while backoff serves the cache", async () => {
    const io = fakeIo();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      if (fetches === 1) return freshQuota("kimi", 40);
      return rateLimitedQuota("kimi");
    };

    // Prime, then 429 with a long backoff so later reads keep serving the cache.
    await readThroughUsageCache("kimi", fetch, {
      io,
      config: { backoffBaseSeconds: 7_200, backoffCapSeconds: 7_200 },
    });
    io.advance(DEFAULT_USAGE_CACHE_CONFIG.ttlSeconds * 1000 + 1);
    await readThroughUsageCache("kimi", fetch, {
      io,
      config: { backoffBaseSeconds: 7_200, backoffCapSeconds: 7_200 },
    });

    io.advance(120_000); // ~2 minutes total: fresh tier
    const fresh = await readThroughUsageCache("kimi", fetch, {
      io,
      config: { backoffBaseSeconds: 7_200, backoffCapSeconds: 7_200 },
    });
    expect(fresh.state.usageCache?.servedFromCache).toBe(true);
    expect(fresh.state.usageCache?.trust).toBe("fresh");

    io.advance(600_000); // now past the 10-minute aging threshold
    const aging = await readThroughUsageCache("kimi", fetch, {
      io,
      config: { backoffBaseSeconds: 7_200, backoffCapSeconds: 7_200 },
    });
    expect(aging.state.usageCache?.trust).toBe("aging");

    io.advance(2_700_000); // now past the 1-hour unknown threshold
    const unknown = await readThroughUsageCache("kimi", fetch, {
      io,
      config: { backoffBaseSeconds: 7_200, backoffCapSeconds: 7_200 },
    });
    expect(unknown.state.usageCache?.trust).toBe("unknown");
    // The whole aging arc served the cache: exactly the priming + one 429 fetch.
    expect(fetches).toBe(2);
  });
});

describe("shared usage cache safety", () => {
  it("never stores account identity or source attempts", async () => {
    useTempCache();
    const io = defaultUsageCacheIo;
    const sentinel = "USAGE-CACHE-SENTINEL-902173";
    const fetch = async (): Promise<ProviderQuota> => ({
      ...freshQuota("claude", 12),
      account: { email: sentinel, accountId: sentinel },
      attempts: [{ source: "oauth", status: "success", error: sentinel }],
    });

    await readThroughUsageCache("claude", fetch, { io });

    const bytes = readFileSync(usageCacheRecordPath("claude"), "utf8");
    expect(bytes).not.toContain(sentinel);
    expect(bytes).not.toContain("account");
    expect(bytes).not.toContain("attempts");
    expect(statSync(usageCacheRecordPath("claude")).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite a good payload with a non-fresh result", async () => {
    const io = fakeIo();
    let fetches = 0;
    const fetch = async (): Promise<ProviderQuota> => {
      fetches++;
      if (fetches === 1) return freshQuota("grok", 20);
      return {
        provider: "grok",
        label: "Grok",
        source: "unavailable",
        windows: [],
        state: { status: "error", stale: false, sourcesTried: ["web"] },
      };
    };

    await readThroughUsageCache("grok", fetch, { io });
    io.advance(DEFAULT_USAGE_CACHE_CONFIG.ttlSeconds * 1000 + 1);
    const errored = await readThroughUsageCache("grok", fetch, { io });

    expect(errored.state.status).toBe("error");
    const record = io.readRecord(usageCacheRecordPath("grok"));
    expect(record?.payload?.windows[0].percentUsed).toBe(20);
  });

  it("uses the real filesystem lock exclusively", () => {
    useTempCache();
    const lock = usageCacheLockPath("claude");
    expect(defaultUsageCacheIo.tryAcquireLock(lock, "holder-a")).toBe(true);
    expect(defaultUsageCacheIo.tryAcquireLock(lock, "holder-b")).toBe(false);
    defaultUsageCacheIo.releaseLock(lock);
    expect(defaultUsageCacheIo.tryAcquireLock(lock, "holder-c")).toBe(true);
    defaultUsageCacheIo.releaseLock(lock);
  });
});

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-usage-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

/**
 * An in-memory {@link UsageCacheIo} with a controllable clock and deterministic
 * randomness, so single-flight and backoff behavior are proven without real
 * files, wall-clock waits, or nondeterministic jitter.
 */
function fakeIo(): UsageCacheIo & {
  advance(ms: number): void;
  readRecord(path: string): UsageCacheRecord | undefined;
} {
  const store = new Map<string, UsageCacheRecord>();
  const locks = new Map<string, number>();
  let clock = Date.parse("2026-08-13T00:00:00.000Z");

  return {
    now: () => clock,
    random: () => 0.5,
    // A virtual sleep both yields to other pending promises and advances the
    // shared clock, so single-flight coalescing resolves deterministically
    // without real wall-clock waits.
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(() => {
          clock += ms;
          resolve();
        }, 0);
      }),
    readRecord: (path) => {
      const record = store.get(path);
      return record ? structuredClone(record) : undefined;
    },
    writeRecord: (path, record) => {
      store.set(path, structuredClone(record));
    },
    tryAcquireLock: (path) => {
      if (locks.has(path)) return false;
      locks.set(path, clock);
      return true;
    },
    lockAgeMs: (path, now) => {
      const at = locks.get(path);
      return at === undefined ? undefined : Math.max(0, now - at);
    },
    releaseLock: (path) => {
      locks.delete(path);
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

function freshQuota(
  provider: ProviderQuota["provider"],
  percentUsed: number,
): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "oauth",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed,
        percentRemaining: 100 - percentUsed,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-08-13T00:00:00.000Z",
      sourcesTried: ["oauth"],
    },
  };
}

function rateLimitedQuota(provider: ProviderQuota["provider"]): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "unavailable",
    windows: [],
    state: {
      status: "rate_limited",
      stale: false,
      error: "rate_limited",
      sourcesTried: ["oauth"],
    },
  };
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDeclaredWindows,
  fetchQuota,
  inspectAuth,
  OPENCODE_MONTH_SECONDS,
  OPENCODE_SESSION_SECONDS,
  OPENCODE_WEEK_SECONDS,
} from "../../src/providers/opencode.js";

const originalAuthJson = process.env.OPENCODE_AUTH_JSON;
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalHome = process.env.HOME;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-opencode-"));
  process.env.OPENCODE_AUTH_JSON = join(tempDir, "auth.json");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  delete process.env.OPENCODE_AUTH_CONTENT;
});

afterEach(() => {
  restore("OPENCODE_AUTH_JSON", originalAuthJson);
  restore("OPENCODE_AUTH_CONTENT", originalAuthContent);
  restore("XDG_DATA_HOME", originalXdgDataHome);
  restore("XDG_CACHE_HOME", originalXdgCacheHome);
  restore("HOME", originalHome);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeAuthJson(value: unknown): void {
  const path = process.env.OPENCODE_AUTH_JSON!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const options = { allowKeychainPrompt: false };

describe("opencode declared windows", () => {
  it("declares the Go plan's $12/5h, $30/week, $60/month windows", () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    const windows = buildDeclaredWindows(now);
    const byId = new Map(windows.map((w) => [w.id, w]));

    const session = byId.get("five_hour");
    expect(session?.limitUsd).toBe(12);
    expect(session?.windowSeconds).toBe(OPENCODE_SESSION_SECONDS);
    expect(session?.percentRemaining).toBe(100);
    expect(session?.resetsAt).toBe(
      new Date(now.getTime() + OPENCODE_SESSION_SECONDS * 1000).toISOString(),
    );

    const weekly = byId.get("weekly");
    expect(weekly?.limitUsd).toBe(30);
    expect(weekly?.windowSeconds).toBe(OPENCODE_WEEK_SECONDS);
    expect(weekly?.percentRemaining).toBe(100);

    const monthly = byId.get("monthly");
    expect(monthly?.limitUsd).toBe(60);
    expect(monthly?.windowSeconds).toBe(OPENCODE_MONTH_SECONDS);
    expect(monthly?.percentRemaining).toBe(100);
  });

  it("models per-model $15/month caps as model windows", () => {
    const windows = buildDeclaredWindows(new Date("2026-08-14T00:00:00.000Z"));
    const modelWindows = windows.filter((w) => w.kind === "model");
    expect(modelWindows.length).toBeGreaterThan(0);
    for (const window of modelWindows) {
      expect(window.limitUsd).toBe(15);
      expect(window.percentRemaining).toBe(100);
      expect(window.resetsAt).toBeTruthy();
    }
  });
});

describe("opencode fetchQuota", () => {
  it("reports declared windows for an authenticated api-key account", async () => {
    writeAuthJson({ opencode: { type: "api", key: "sk-opencode-test" } });
    const quota = await fetchQuota(options);
    expect(quota.provider).toBe("opencode");
    expect(quota.state.status).toBe("fresh");
    expect(quota.state.authStatus).toBe("usable");
    const ids = quota.windows.map((w) => w.id);
    expect(ids).toContain("five_hour");
    expect(ids).toContain("weekly");
    expect(ids).toContain("monthly");
    for (const window of quota.windows) {
      expect(window.percentRemaining).toBe(100);
      expect(window.resetsAt).toBeTruthy();
    }
  });

  it("accepts an unexpired oauth credential as usable", async () => {
    writeAuthJson({
      opencode: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3_600_000,
      },
    });
    const quota = await fetchQuota(options);
    expect(quota.state.status).toBe("fresh");
    expect(quota.state.authStatus).toBe("usable");
    expect(quota.windows.length).toBeGreaterThan(0);
  });

  it("reads inline OPENCODE_AUTH_CONTENT credentials", async () => {
    delete process.env.OPENCODE_AUTH_JSON;
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      opencode: { type: "api", key: "sk-inline" },
    });
    const quota = await fetchQuota(options);
    expect(quota.state.status).toBe("fresh");
    expect(quota.windows.length).toBeGreaterThan(0);
  });

  it("treats an expired oauth credential as soft-expired refreshable", async () => {
    writeAuthJson({
      opencode: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() - 3_600_000,
      },
    });
    const quota = await fetchQuota(options);
    expect(quota.state.status).toBe("auth_required");
    expect(quota.state.authStatus).toBe("expired_refreshable");
    expect(quota.windows).toEqual([]);
  });

  it("reports auth_required with no credentials", async () => {
    const quota = await fetchQuota(options);
    expect(quota.state.status).toBe("auth_required");
    expect(quota.state.authStatus).toBe("unusable");
    expect(quota.windows).toEqual([]);
  });
});

describe("opencode inspectAuth", () => {
  it("reports an available source when a credential is present", async () => {
    writeAuthJson({ opencode: { type: "api", key: "sk" } });
    const report = await inspectAuth(options);
    expect(report.provider).toBe("opencode");
    expect(report.sources[0]?.status).toBe("available");
  });

  it("reports a missing source when the auth file is absent", async () => {
    const report = await inspectAuth(options);
    expect(report.sources[0]?.status).toBe("missing");
  });
});

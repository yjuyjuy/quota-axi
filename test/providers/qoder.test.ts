import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDeclaredWindows,
  fetchQuota,
  inspectAuth,
  planCreditBudget,
  QODER_MONTH_SECONDS,
  resolvePlan,
} from "../../src/providers/qoder.js";

const originalAuthJson = process.env.QODER_AUTH_JSON;
const originalAuthContent = process.env.QODER_AUTH_CONTENT;
const originalHome = process.env.QODER_HOME;
const originalPlan = process.env.QODER_PLAN;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-qoder-"));
  process.env.QODER_AUTH_JSON = join(tempDir, "user");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  delete process.env.QODER_AUTH_CONTENT;
  delete process.env.QODER_HOME;
  delete process.env.QODER_PLAN;
});

afterEach(() => {
  restore("QODER_AUTH_JSON", originalAuthJson);
  restore("QODER_AUTH_CONTENT", originalAuthContent);
  restore("QODER_HOME", originalHome);
  restore("QODER_PLAN", originalPlan);
  restore("XDG_CACHE_HOME", originalXdgCacheHome);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeAuthFile(value: unknown): void {
  const path = process.env.QODER_AUTH_JSON!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const options = { allowKeychainPrompt: false };

describe("qoder plan resolution", () => {
  it("maps each plan to its declared monthly credit budget", () => {
    expect(planCreditBudget("pro")).toBe(2000);
    expect(planCreditBudget("pro_plus")).toBe(6000);
    expect(planCreditBudget("ultra")).toBe(20000);
  });

  it("resolves the plan from the QODER_PLAN override with aliases", () => {
    expect(resolvePlan(undefined, "ultra")).toBe("ultra");
    expect(resolvePlan(undefined, "pro+")).toBe("pro_plus");
    expect(resolvePlan(undefined, "Pro Plus")).toBe("pro_plus");
    expect(resolvePlan(undefined, "PRO")).toBe("pro");
  });

  it("resolves the plan from an auth-file subscription hint", () => {
    expect(resolvePlan("professional_plus", undefined)).toBe("pro_plus");
    expect(resolvePlan("ultra", undefined)).toBe("ultra");
  });

  it("prefers the explicit override over the auth-file hint", () => {
    expect(resolvePlan("pro", "ultra")).toBe("ultra");
  });

  it("defaults to pro when nothing is known", () => {
    expect(resolvePlan(undefined, undefined)).toBe("pro");
    expect(resolvePlan("mystery-tier", "nonsense")).toBe("pro");
  });
});

describe("qoder declared windows", () => {
  it("declares a monthly credits window sized to the plan budget", () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    const windows = buildDeclaredWindows("ultra", now);
    expect(windows).toHaveLength(1);
    const monthly = windows[0];
    expect(monthly.id).toBe("monthly");
    expect(monthly.kind).toBe("credits");
    expect(monthly.percentUsed).toBe(0);
    expect(monthly.percentRemaining).toBe(100);
    expect(monthly.windowSeconds).toBe(QODER_MONTH_SECONDS);
    expect(monthly.resetsAt).toBe(
      new Date(now.getTime() + QODER_MONTH_SECONDS * 1000).toISOString(),
    );
  });
});

describe("qoder fetchQuota", () => {
  it("reports the declared monthly window for a signed-in account", async () => {
    writeAuthFile({ accessToken: "qoder-access-token" });
    const quota = await fetchQuota(options);
    expect(quota.provider).toBe("qoder");
    expect(quota.state.status).toBe("fresh");
    expect(quota.state.authStatus).toBe("usable");
    expect(quota.plan).toBe("pro");
    const monthly = quota.windows.find((w) => w.id === "monthly");
    expect(monthly?.kind).toBe("credits");
    expect(monthly?.percentRemaining).toBe(100);
    expect(monthly?.resetsAt).toBeTruthy();
    expect(quota.credits).toEqual({ remaining: 2000, unit: "credits" });
  });

  it("sizes the declared budget from the QODER_PLAN override", async () => {
    writeAuthFile({ accessToken: "qoder-access-token" });
    process.env.QODER_PLAN = "pro+";
    const quota = await fetchQuota(options);
    expect(quota.plan).toBe("pro_plus");
    expect(quota.credits).toEqual({ remaining: 6000, unit: "credits" });
  });

  it("sizes the declared budget from an auth-file subscription hint", async () => {
    writeAuthFile({ accessToken: "t", subscriptionType: "ultra" });
    const quota = await fetchQuota(options);
    expect(quota.plan).toBe("ultra");
    expect(quota.credits).toEqual({ remaining: 20000, unit: "credits" });
  });

  it("accepts an unexpired oauth credential as usable", async () => {
    writeAuthFile({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3_600_000,
    });
    const quota = await fetchQuota(options);
    expect(quota.state.status).toBe("fresh");
    expect(quota.state.authStatus).toBe("usable");
    expect(quota.windows.length).toBeGreaterThan(0);
  });

  it("reads inline QODER_AUTH_CONTENT credentials", async () => {
    delete process.env.QODER_AUTH_JSON;
    process.env.QODER_AUTH_CONTENT = JSON.stringify({ accessToken: "inline" });
    const quota = await fetchQuota(options);
    expect(quota.state.status).toBe("fresh");
    expect(quota.windows.length).toBeGreaterThan(0);
  });

  it("treats an expired oauth credential as soft-expired refreshable", async () => {
    writeAuthFile({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 3_600_000,
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

describe("qoder inspectAuth", () => {
  it("reports an available source when a credential is present", async () => {
    writeAuthFile({ accessToken: "token" });
    const report = await inspectAuth(options);
    expect(report.provider).toBe("qoder");
    expect(report.sources[0]?.status).toBe("available");
  });

  it("reports a missing source when the auth file is absent", async () => {
    const report = await inspectAuth(options);
    expect(report.sources[0]?.status).toBe("missing");
  });
});

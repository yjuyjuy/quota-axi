import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastValidPolicyPath,
  orchestratorConfigDir,
  policyFilePath,
  registryFilePath,
} from "../../src/orchestrator/paths.js";

const ENV_KEYS = [
  "QUOTA_AXI_CONFIG_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "QUOTA_AXI_REGISTRY",
  "QUOTA_AXI_POLICY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("orchestrator paths", () => {
  it("prefers QUOTA_AXI_CONFIG_HOME for the config directory", () => {
    process.env.QUOTA_AXI_CONFIG_HOME = "/custom/config";
    expect(orchestratorConfigDir()).toBe("/custom/config");
    expect(registryFilePath()).toBe("/custom/config/accounts.yaml");
    expect(policyFilePath()).toBe("/custom/config/policy.yaml");
  });

  it("falls back to XDG_CONFIG_HOME then ~/.config", () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(orchestratorConfigDir()).toBe("/xdg/quota-axi");
  });

  it("lets per-file overrides win over the config directory", () => {
    process.env.QUOTA_AXI_CONFIG_HOME = "/custom/config";
    process.env.QUOTA_AXI_REGISTRY = "/elsewhere/accounts.yaml";
    process.env.QUOTA_AXI_POLICY = "/elsewhere/policy.yaml";
    expect(registryFilePath()).toBe("/elsewhere/accounts.yaml");
    expect(policyFilePath()).toBe("/elsewhere/policy.yaml");
  });

  it("keeps the last-valid snapshot under the cache directory", () => {
    process.env.XDG_CACHE_HOME = "/cache";
    expect(lastValidPolicyPath()).toBe(
      "/cache/quota-axi/last-valid-policy.json",
    );
  });
});

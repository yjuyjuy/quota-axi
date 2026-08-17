import { describe, expect, it } from "vitest";
import {
  buildCswapSwitchArgs,
  parseCswapSwitch,
} from "../../src/orchestrator/claude-surface.js";

describe("buildCswapSwitchArgs", () => {
  it("builds a non-interactive switch-to with --json", () => {
    expect(buildCswapSwitchArgs("claude-max-primary")).toEqual([
      "switch",
      "claude-max-primary",
      "--json",
    ]);
  });

  it("passes the target as a positional argument", () => {
    const args = buildCswapSwitchArgs("2");
    // The target is positional (cswap `switch <num|email|alias>`), never a flag.
    expect(args[1]).toBe("2");
    expect(args).not.toContain("--target");
  });
});

describe("parseCswapSwitch", () => {
  it("maps a real applied switch onto `applied`", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      switched: true,
      from: { number: 1, email: "a@example.com" },
      to: { number: 2, email: "b@example.com" },
      strategy: "direct",
      reason: "switched",
      message: "Switched to Account-2 (b@example.com)",
      warnings: [],
    });
    expect(parseCswapSwitch("2", stdout, 0)).toEqual({
      status: "applied",
      target: "2",
      account: { number: 2, email: "b@example.com" },
    });
  });

  it("maps a `switched: false` direct switch onto `already-active`", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      switched: false,
      from: { number: 1, email: "a@example.com" },
      to: { number: 1, email: "a@example.com" },
      strategy: "direct",
      reason: "already-active",
      message: "Already on Account-1 (a@example.com)",
      warnings: [],
    });
    expect(parseCswapSwitch("1", stdout, 0)).toEqual({
      status: "already-active",
      target: "1",
      account: { number: 1, email: "a@example.com" },
    });
  });

  it("maps cswap's JSON error envelope (exit 1) onto `failed`", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      error: {
        type: "ValidationError",
        message: "Invalid account identifier: nope",
      },
    });
    expect(parseCswapSwitch("nope", stdout, 1)).toEqual({
      status: "failed",
      target: "nope",
      error: "Invalid account identifier: nope",
    });
  });

  it("treats unparseable output as a failure, not a false success", () => {
    const outcome = parseCswapSwitch("2", "not json at all", 0);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("no parseable JSON");
    }
  });

  it("treats a success-shaped payload with a non-zero exit as a failure", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      switched: true,
      to: { number: 2, email: "b@example.com" },
    });
    const outcome = parseCswapSwitch("2", stdout, 1);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("exited 1");
    }
  });

  it("still reports applied when cswap omits the `to` account ref", () => {
    const stdout = JSON.stringify({ schemaVersion: 1, switched: true });
    expect(parseCswapSwitch("2", stdout, 0)).toEqual({
      status: "applied",
      target: "2",
    });
  });
});

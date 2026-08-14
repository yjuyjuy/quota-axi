import { describe, expect, it } from "vitest";
import {
  buildSwitchAccountArgs,
  parseSessionList,
  parseSwitchResult,
} from "../../src/orchestrator/jcode-surface.js";

describe("buildSwitchAccountArgs", () => {
  it("builds an --all account-only switch (no --model in Phase 1)", () => {
    const args = buildSwitchAccountArgs({
      account: "claude-max-primary",
      all: true,
    });
    expect(args).toEqual([
      "session",
      "switch-account",
      "--account",
      "claude-max-primary",
      "--all",
      "--json",
    ]);
    expect(args).not.toContain("--model");
  });

  it("builds a per-session switch", () => {
    const args = buildSwitchAccountArgs({
      account: "claude-max-primary",
      session: "session-a",
    });
    expect(args).toEqual([
      "session",
      "switch-account",
      "--account",
      "claude-max-primary",
      "--session",
      "session-a",
      "--json",
    ]);
  });

  it("passes --model only when a caller explicitly sets it (Phase 2 hook)", () => {
    const args = buildSwitchAccountArgs({
      account: "claude-max-primary",
      all: true,
      model: "claude-opus-4-6",
    });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-6");
  });
});

describe("parseSessionList", () => {
  it("parses a bare array of sessions", () => {
    const list = parseSessionList(
      JSON.stringify([
        { id: "s1", provider: "claude", account: "a1", model: "m1" },
        { id: "s2" },
      ]),
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: "s1",
      provider: "claude",
      account: "a1",
      model: "m1",
    });
  });

  it("parses a { sessions: [] } envelope", () => {
    const list = parseSessionList(JSON.stringify({ sessions: [{ id: "s1" }] }));
    expect(list).toEqual([{ id: "s1" }]);
  });

  it("returns an empty list for junk", () => {
    expect(parseSessionList("not json")).toEqual([]);
  });
});

describe("parseSwitchResult", () => {
  it("maps a deferred status to deferred", () => {
    expect(parseSwitchResult(JSON.stringify({ status: "deferred" }))).toEqual({
      application: "deferred",
    });
  });

  it("defaults to applied", () => {
    expect(parseSwitchResult(JSON.stringify({ status: "applied" }))).toEqual({
      application: "applied",
    });
  });

  it("captures affected sessions when named", () => {
    const result = parseSwitchResult(
      JSON.stringify({ status: "applied", sessions: ["s1", "s2"] }),
    );
    expect(result.sessions).toEqual(["s1", "s2"]);
  });
});

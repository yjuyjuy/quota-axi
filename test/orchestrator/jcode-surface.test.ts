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
      "--all",
      "--account",
      "claude-max-primary",
      "--json",
    ]);
    expect(args).not.toContain("--model");
  });

  it("builds a per-session switch with the session as a positional arg", () => {
    const args = buildSwitchAccountArgs({
      account: "claude-max-primary",
      session: "session-a",
    });
    expect(args).toEqual([
      "session",
      "switch-account",
      "session-a",
      "--account",
      "claude-max-primary",
      "--json",
    ]);
    // The session id is positional, never behind --session.
    expect(args).not.toContain("--session");
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
  it("parses the real bare array of session_id-keyed rows (SessionListRow)", () => {
    const list = parseSessionList(
      JSON.stringify([
        {
          session_id: "s1",
          name: "fox",
          provider: "claude",
          account: "a1",
          model: "m1",
          is_processing: true,
        },
        { session_id: "s2", is_processing: false },
      ]),
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: "s1",
      name: "fox",
      provider: "claude",
      account: "a1",
      model: "m1",
      isProcessing: true,
    });
    expect(list[1]).toEqual({ id: "s2", isProcessing: false });
  });

  it("drops a row without a string session_id", () => {
    const list = parseSessionList(
      JSON.stringify([{ id: "wrong-key" }, { session_id: "ok" }]),
    );
    expect(list).toEqual([{ id: "ok" }]);
  });

  it("returns an empty list for junk or a non-array envelope", () => {
    expect(parseSessionList("not json")).toEqual([]);
    expect(parseSessionList(JSON.stringify({ sessions: [] }))).toEqual([]);
  });
});

describe("parseSwitchResult", () => {
  it("parses the real bare array of per-session outcomes (SessionSwitchOutcome)", () => {
    const result = parseSwitchResult(
      JSON.stringify([
        {
          session_id: "s1",
          ok: true,
          account: "claude-max-primary",
          deferred: false,
        },
        {
          session_id: "s2",
          ok: true,
          account: "claude-max-primary",
          deferred: true,
        },
      ]),
    );
    expect(result.outcomes).toEqual([
      {
        sessionId: "s1",
        ok: true,
        account: "claude-max-primary",
        deferred: false,
      },
      {
        sessionId: "s2",
        ok: true,
        account: "claude-max-primary",
        deferred: true,
      },
    ]);
  });

  it("preserves a per-session failure with its error", () => {
    const result = parseSwitchResult(
      JSON.stringify([
        {
          session_id: "s1",
          ok: false,
          deferred: false,
          error: "no such account",
        },
      ]),
    );
    expect(result.outcomes[0]).toEqual({
      sessionId: "s1",
      ok: false,
      deferred: false,
      error: "no such account",
    });
  });

  it("captures a model only when jcode reports one", () => {
    const result = parseSwitchResult(
      JSON.stringify([
        { session_id: "s1", ok: true, deferred: false, model: "claude-opus" },
      ]),
    );
    expect(result.outcomes[0].model).toBe("claude-opus");
  });

  it("returns an empty outcome list for junk", () => {
    expect(parseSwitchResult("not json")).toEqual({ outcomes: [] });
  });
});

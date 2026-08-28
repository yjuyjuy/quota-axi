import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshDelegateAttempt,
  runRefreshDelegate,
  type RefreshDelegate,
} from "../../src/providers/delegated-refresh.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalUser = process.env.USER;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalCodexHome = process.env.CODEX_HOME;
const originalCodexBinary = process.env.QUOTA_AXI_CODEX_BINARY;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-delegated-refresh-"));
  usePlatform("linux");
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.USER = "fixture-user";
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.PATH = join(tempDir, "empty-bin");
  process.env.PATHEXT = ".CMD;.EXE";
  process.env.CODEX_HOME = join(tempDir, ".codex");
  delete process.env.QUOTA_AXI_CODEX_BINARY;
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
  restore("HOME", originalHome);
  restore("USERPROFILE", originalUserProfile);
  restore("USER", originalUser);
  restore("XDG_CACHE_HOME", originalXdgCacheHome);
  restore("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
  restore("PATH", originalPath);
  restore("PATHEXT", originalPathExt);
  restore("CODEX_HOME", originalCodexHome);
  restore("QUOTA_AXI_CODEX_BINARY", originalCodexBinary);
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

/**
 * Install an executable on the PATH quota-axi will search. The body may only
 * use shell builtins, because a delegated run inherits exactly the PATH the
 * process has - here, a directory holding nothing but this stub.
 */
function installStub(name: string, body: string[]): string {
  const binDir = join(tempDir, "stub-bin");
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, name);
  writeFileSync(file, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(file, 0o755);
  process.env.PATH = binDir;
  return file;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delegateFor(name: string, timeoutMs = 5_000): RefreshDelegate {
  return { source: `${name}-refresh`, command: name, args: [], timeoutMs };
}

// These delegate behavior suites are POSIX-only by design: their executable
// fixtures are `#!/bin/sh` stubs, so Windows skips them explicitly.
describe.skipIf(process.platform === "win32")(
  "delegated refresh machinery",
  () => {
    it("resolves the vendor command on PATH and reports its completion", async () => {
      const marker = join(tempDir, "ran");
      installStub("vendorcli", [`echo yes > ${JSON.stringify(marker)}`]);

      const run = await runRefreshDelegate({
        source: "vendor-refresh",
        command: "vendorcli",
        args: ["models"],
        timeoutMs: 5_000,
      });

      expect(run).toEqual({ status: "ran", exitCode: 0 });
      expect(existsSync(marker)).toBe(true);
    });

    it("carries no vendor output, so no credential can be parsed out of it", async () => {
      // A vendor CLI printing something token-shaped must not become a source.
      installStub("vendorcli", ['echo "access_token=printed-by-vendor"']);

      const run = await runRefreshDelegate(delegateFor("vendorcli"));

      expect(Object.keys(run).sort()).toEqual(["exitCode", "status"]);
      expect(JSON.stringify(run)).not.toContain("printed-by-vendor");
    });

    it("gives the child no stdin, so a command that would prompt exits", async () => {
      const captured = join(tempDir, "stdin-capture");
      installStub("vendorcli", [
        `while read line; do echo "$line" >> ${JSON.stringify(captured)}; done`,
        `echo done > ${JSON.stringify(join(tempDir, "finished"))}`,
      ]);

      const run = await runRefreshDelegate(delegateFor("vendorcli", 4_000));

      expect(run).toEqual({ status: "ran", exitCode: 0 });
      expect(existsSync(join(tempDir, "finished"))).toBe(true);
      expect(existsSync(captured)).toBe(false);
    });

    it("terminates a vendor command that outruns its budget", async () => {
      // An absolute command path also exercises the non-PATH resolution branch.
      const started = Date.now();
      const run = await runRefreshDelegate({
        source: "vendor-refresh",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 300,
      });

      expect(run).toEqual({ status: "failed", error: "refresh_timed_out" });
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("reports an absent vendor CLI without spawning anything", async () => {
      const run = await runRefreshDelegate(delegateFor("definitely-not-here"));

      expect(run).toEqual({
        status: "unavailable",
        error: "refresh_command_not_found",
      });
    });

    it("records a non-zero exit as a failed attempt", async () => {
      installStub("vendorcli", ["exit 3"]);
      const delegate = delegateFor("vendorcli");

      const run = await runRefreshDelegate(delegate);

      expect(run).toEqual({ status: "ran", exitCode: 3 });
      expect(refreshDelegateAttempt(delegate, run)).toEqual({
        source: "vendorcli-refresh",
        status: "failed",
        error: "refresh_exit_status",
      });
    });
  },
);

type ClaudeStub = { invocationCount(): number; arguments(): string[] };

function stubClaudeCli(options: { rotateTo?: string } = {}): ClaudeStub {
  const log = join(tempDir, "claude-invocations.log");
  const rotate = options.rotateTo
    ? `echo ${shellSingleQuote(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: options.rotateTo,
            // Opaque presence marker: quota-axi must not inspect this field.
            refreshToken: true,
            expiresAt: Date.parse("2035-01-01T00:00:00.000Z"),
            subscriptionType: "max",
          },
        }),
      )} > ${JSON.stringify(join(tempDir, ".claude", ".credentials.json"))}`
    : "";
  installStub("claude", [
    `echo "$@" >> ${JSON.stringify(log)}`,
    'echo "Claude Code doctor"',
    rotate,
    "exit 0",
  ]);
  const lines = () =>
    existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  return { invocationCount: () => lines().length, arguments: lines };
}

function writeExpiredClaudeCredential(refreshable = true): void {
  mkdirSync(join(tempDir, ".claude"), { recursive: true });
  writeFileSync(
    join(tempDir, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "stale-access-token",
        expiresAt: Date.parse("2020-01-01T00:00:00.000Z"),
        subscriptionType: "max",
        // Deliberately not a token fixture. Only field presence is observable.
        ...(refreshable ? { refreshToken: true } : {}),
      },
    }),
  );
}

function writeValidClaudeCredential(): void {
  mkdirSync(join(tempDir, ".claude"), { recursive: true });
  writeFileSync(
    join(tempDir, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "stored-valid-access-token",
        refreshToken: true,
        expiresAt: Date.parse("2035-01-01T00:00:00.000Z"),
        subscriptionType: "max",
      },
    }),
  );
}

type RecordedRequest = { url: string; init: RequestInit | undefined };

/** 401 for the stale bearer, live usage for the rotated one. */
function stubBearerAwareFetch(liveToken: string): {
  mock: ReturnType<typeof vi.fn>;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== `Bearer ${liveToken}`) {
      return new Response(null, { status: 401 });
    }
    if (url === PROFILE_URL) {
      return Response.json({
        account: { uuid: "account-uuid-fixture", email: "user@example.test" },
      });
    }
    return Response.json({
      five_hour: { utilization: 40, resets_at: "2035-01-01T00:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: "2035-01-05T00:00:00.000Z" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return { mock, requests };
}

describe.skipIf(process.platform === "win32")(
  "Claude delegated credential refresh",
  () => {
    it("recovers live quota by letting the Claude CLI rotate its own session", async () => {
      writeExpiredClaudeCredential();
      const cli = stubClaudeCli({ rotateTo: "rotated-access-token" });
      const { requests } = stubBearerAwareFetch("rotated-access-token");

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      expect(result).toMatchObject({
        source: "oauth",
        state: { status: "fresh", stale: false },
      });
      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.state.sourcesTried).toContain("claude-cli-refresh");
      expect(result.attempts).toContainEqual({
        source: "claude-cli-refresh",
        status: "success",
      });
      // The vendor CLI ran once, with its own smallest read-only command.
      expect(cli.invocationCount()).toBe(1);
      expect(cli.arguments()).toEqual(["doctor"]);
      // The store the CLI rewrote is what quota-axi read back.
      const stored = JSON.parse(
        readFileSync(join(tempDir, ".claude", ".credentials.json"), "utf8"),
      ) as { claudeAiOauth: { accessToken: string } };
      expect(stored.claudeAiOauth.accessToken).toBe("rotated-access-token");
      expect(requests.map((request) => request.url)).toEqual([
        USAGE_URL,
        USAGE_URL,
        PROFILE_URL,
      ]);
    });

    it("never performs the refresh-token exchange itself", async () => {
      writeExpiredClaudeCredential();
      stubClaudeCli({ rotateTo: "rotated-access-token" });
      const { requests } = stubBearerAwareFetch("rotated-access-token");

      const { fetchQuota } = await import("../../src/providers/claude.js");
      await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      for (const request of requests) {
        // Only the read-only usage and profile reads, never a token endpoint.
        expect([USAGE_URL, PROFILE_URL]).toContain(request.url);
        expect(request.init?.method ?? "GET").toBe("GET");
        const serialized = JSON.stringify({
          url: request.url,
          headers: request.init?.headers ?? null,
          body: request.init?.body ?? null,
        });
        expect(serialized).not.toContain("grant_type");
      }
    });

    it("keeps credential material out of the report", async () => {
      writeExpiredClaudeCredential();
      stubClaudeCli({ rotateTo: "rotated-access-token" });
      stubBearerAwareFetch("rotated-access-token");

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      const report = JSON.stringify(result);
      expect(report).not.toContain("rotated-access-token");
      expect(report).not.toContain("stale-access-token");
    });

    it("stays read-only when delegated refresh is turned off", async () => {
      writeExpiredClaudeCredential();
      const cli = stubClaudeCli({ rotateTo: "rotated-access-token" });
      stubBearerAwareFetch("rotated-access-token");

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(cli.invocationCount()).toBe(0);
      expect(result.state.status).not.toBe("fresh");
      expect(result.state.sourcesTried).not.toContain("claude-cli-refresh");
    });

    it("does not delegate for a stored-valid credential rejected by the server", async () => {
      writeValidClaudeCredential();
      const cli = stubClaudeCli({ rotateTo: "rotated-access-token" });
      const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cli.invocationCount()).toBe(0);
      expect(result.state.sourcesTried).not.toContain("claude-cli-refresh");
    });

    it("does not combine a rejected valid Keychain credential with a transient expired file credential", async () => {
      usePlatform("darwin");
      writeExpiredClaudeCredential();
      const cli = stubClaudeCli({ rotateTo: "rotated-access-token" });
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return new Response(null, {
          status:
            headers.authorization === "Bearer keychain-valid-token" ? 401 : 500,
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.doMock("../../src/lib/process.js", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("../../src/lib/process.js")>();
        return {
          ...actual,
          execFileText: vi.fn(async () =>
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "keychain-valid-token",
                refreshToken: true,
                expiresAt: Date.parse("2035-01-01T00:00:00.000Z"),
                subscriptionType: "max",
              },
            }),
          ),
        };
      });

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cli.invocationCount()).toBe(0);
      expect(result.state.sourcesTried).not.toContain("claude-cli-refresh");
      vi.doUnmock("../../src/lib/process.js");
    });

    it("does not delegate for a transient failure", async () => {
      writeExpiredClaudeCredential();
      const cli = stubClaudeCli({ rotateTo: "rotated-access-token" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 500 })),
      );

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      expect(cli.invocationCount()).toBe(0);
      expect(result.state.sourcesTried).not.toContain("claude-cli-refresh");
    });

    it("does not delegate when the store holds no refresh path", async () => {
      writeExpiredClaudeCredential(false);
      const cli = stubClaudeCli({ rotateTo: "rotated-access-token" });
      stubBearerAwareFetch("rotated-access-token");

      const { fetchQuota } = await import("../../src/providers/claude.js");
      await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      expect(cli.invocationCount()).toBe(0);
    });

    it("keeps Keychain advice instead of delegating when the value read is withheld", async () => {
      usePlatform("darwin");
      writeExpiredClaudeCredential();
      const cli = stubClaudeCli({ rotateTo: "rotated-access-token" });
      stubBearerAwareFetch("rotated-access-token");
      // A present Keychain item quota-axi has not been granted permission to read.
      vi.doMock("../../src/lib/process.js", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("../../src/lib/process.js")>();
        return { ...actual, execFileText: vi.fn(async () => "") };
      });

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      expect(cli.invocationCount()).toBe(0);
      expect(result.attempts).toContainEqual({
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      });
      vi.doUnmock("../../src/lib/process.js");
    });

    it("reports an absent Claude CLI as a skipped refresh instead of failing", async () => {
      writeExpiredClaudeCredential();
      stubBearerAwareFetch("rotated-access-token");

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      expect(result.attempts).toContainEqual({
        source: "claude-cli-refresh",
        status: "skipped",
        error: "refresh_command_not_found",
      });
      expect(result.state.status).not.toBe("fresh");
    });
  },
);

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

function writeCodexAuth(accessToken: string): void {
  mkdirSync(join(tempDir, ".codex"), { recursive: true });
  writeFileSync(
    join(tempDir, ".codex", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2020-01-01T00:00:00.000Z",
      tokens: {
        access_token: accessToken,
        id_token: accessToken,
        // Opaque presence marker: only Codex owns this field.
        refresh_token: true,
        account_id: "codex-account-fixture",
      },
    }),
  );
}

/**
 * A stand-in for `codex app-server`: it rotates the store the way the real
 * binary does before answering, then serves the read-only rate-limit RPC.
 */
function stubCodexAppServer(): void {
  const authFile = join(tempDir, ".codex", "auth.json");
  const rotated = jwt({ exp: Math.floor(Date.parse("2035-01-01") / 1000) });
  const binDir = join(tempDir, "stub-bin");
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, "codex");
  writeFileSync(
    file,
    `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const authFile = ${JSON.stringify(authFile)};
const stored = JSON.parse(readFileSync(authFile, "utf8"));
stored.tokens.access_token = ${JSON.stringify(rotated)};
stored.tokens.id_token = ${JSON.stringify(rotated)};
stored.tokens.refresh_token = true;
stored.last_refresh = new Date().toISOString();
writeFileSync(authFile, JSON.stringify(stored));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    let result = {};
    if (request.method === "account/read") result = { account: null };
    if (request.method === "account/rateLimits/read") {
      result = {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 12, windowDurationMins: 300 },
          secondary: { usedPercent: 4, windowDurationMins: 10080 },
        },
        rateLimitsByLimitId: {},
      };
    }
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  }
});
`,
    { mode: 0o755 },
  );
  chmodSync(file, 0o755);
  process.env.PATH = binDir;
}

describe.skipIf(process.platform === "win32")(
  "Codex delegated credential refresh",
  () => {
    it("reports live quota through the vendor CLI when the stored token is expired", async () => {
      writeCodexAuth(jwt({ exp: Math.floor(Date.parse("2020-01-01") / 1000) }));
      stubCodexAppServer();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { fetchQuota } = await import("../../src/providers/codex.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: true,
      });

      expect(result).toMatchObject({
        source: "cli-rpc",
        state: { status: "fresh", stale: false },
      });
      expect(result.windows.length).toBeGreaterThan(0);
      // The expired bearer is never offered to the usage endpoint, and the
      // rotation is entirely the vendor CLI's: quota-axi made no HTTP call.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.attempts).toContainEqual({
        source: "oauth",
        status: "skipped",
        error: "credentials_expired",
      });

      // The vendor rewrote its own store, so the next run has a live bearer.
      const stored = JSON.parse(
        readFileSync(join(tempDir, ".codex", "auth.json"), "utf8"),
      ) as { tokens: Record<string, unknown> };
      expect(Object.hasOwn(stored.tokens, "refresh_token")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("rotated-access-token");
    });
  },
);

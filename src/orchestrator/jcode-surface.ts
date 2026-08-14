import { execFileText } from "../lib/process.js";

/**
 * The jcode live-session control surface, abstracted behind a seam (ADR 0031,
 * Phase 1).
 *
 * `switch` actuates account moves by driving the jcode CLI as a subprocess:
 * `jcode session list --json` enumerates live sessions, and
 * `jcode session switch-account [--all] [--session <id>] [--model <m>] --json`
 * applies a move with drain semantics (applied immediately when the session is
 * idle, deferred to the session's next turn when a turn holds the agent lock,
 * never interrupting it). This module owns the process boundary and pins to the
 * CLI's `--json` contract; the interface is the seam unit tests mock so they
 * never shell out to a real jcode.
 *
 * Phase 1 is account-only: {@link SwitchAccountRequest.model} exists so the
 * shape is ready for the Phase 2 model map, but the `switch` core never sets it
 * (rotation within the Claude pool never changes the model). The adapter passes
 * `--model` only if a caller explicitly provides one, so the account-only
 * invariant is enforced by the caller, not hidden here.
 */

/** One live session as `jcode session list --json` reports it. */
export type JcodeLiveSession = {
  /** Session id. */
  id: string;
  /** Provider the session runs on, for example `claude`. */
  provider?: string;
  /** Account the session currently runs on. */
  account?: string;
  /** Model the session currently runs on. */
  model?: string;
};

/** A request to move sessions onto a target account. */
export type SwitchAccountRequest = {
  /** Target account id to switch onto. */
  account: string;
  /** Switch every eligible session rather than a single one. */
  all?: boolean;
  /** The single session id to switch, when not switching all. */
  session?: string;
  /**
   * Optional model to switch to alongside the account. Phase 1 leaves this
   * unset (account-only). Reserved for the Phase 2 model map.
   */
  model?: string;
};

/** How the jcode surface applied a switch, per its drain semantics. */
export type SwitchApplication = "applied" | "deferred";

/** The `jcode session switch-account --json` result for one request. */
export type SwitchAccountResult = {
  /** Whether the move applied immediately or was deferred to the next turn. */
  application: SwitchApplication;
  /** Session ids the surface reported as affected, when it names them. */
  sessions?: string[];
};

/**
 * The seam unit tests mock. A real implementation drives the jcode CLI; a fake
 * records calls and returns canned results, so switch logic is tested without a
 * live jcode.
 */
export type JcodeSessionSurface = {
  /** Enumerate live sessions. */
  listSessions(): Promise<JcodeLiveSession[]>;
  /** Apply an account switch. */
  switchAccount(request: SwitchAccountRequest): Promise<SwitchAccountResult>;
};

/**
 * Build the argv for `jcode session switch-account`. Kept pure and exported so
 * a test can assert the account-only invariant directly: Phase 1 never passes
 * `--model`, and `--all` and `--session` are mutually exclusive.
 */
export function buildSwitchAccountArgs(
  request: SwitchAccountRequest,
): string[] {
  const args = ["session", "switch-account", "--account", request.account];
  if (request.all) {
    args.push("--all");
  } else if (request.session !== undefined) {
    args.push("--session", request.session);
  }
  if (request.model !== undefined) {
    args.push("--model", request.model);
  }
  args.push("--json");
  return args;
}

export type JcodeCliSurfaceOptions = {
  /** jcode executable to run. Defaults to `jcode` on `PATH`. */
  binary?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The real jcode surface: drives the jcode CLI as a subprocess and parses its
 * `--json` output. This is intentionally the only place `switch` touches a
 * process; unit tests replace the whole object with a fake.
 */
export function createJcodeCliSurface(
  options: JcodeCliSurfaceOptions = {},
): JcodeSessionSurface {
  const binary = options.binary ?? "jcode";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async listSessions(): Promise<JcodeLiveSession[]> {
      const raw = await execFileText(
        binary,
        ["session", "list", "--json"],
        timeoutMs,
      );
      return parseSessionList(raw);
    },
    async switchAccount(
      request: SwitchAccountRequest,
    ): Promise<SwitchAccountResult> {
      const raw = await execFileText(
        binary,
        buildSwitchAccountArgs(request),
        timeoutMs,
      );
      return parseSwitchResult(raw);
    },
  };
}

/** Parse `jcode session list --json`. Tolerant of a bare array or `{sessions}`. */
export function parseSessionList(raw: string): JcodeLiveSession[] {
  const value = safeJson(raw);
  const list = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions
      : [];
  const out: JcodeLiveSession[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.session ?? record.sessionId;
    if (typeof id !== "string") continue;
    const session: JcodeLiveSession = { id };
    if (typeof record.provider === "string") session.provider = record.provider;
    if (typeof record.account === "string") session.account = record.account;
    if (typeof record.model === "string") session.model = record.model;
    out.push(session);
  }
  return out;
}

/** Parse `jcode session switch-account --json`. Maps its status to application. */
export function parseSwitchResult(raw: string): SwitchAccountResult {
  const value = safeJson(raw);
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const status =
    typeof record.status === "string"
      ? record.status
      : typeof record.application === "string"
        ? record.application
        : undefined;
  const application: SwitchApplication =
    status === "deferred" || status === "queued" || status === "pending"
      ? "deferred"
      : "applied";
  const result: SwitchAccountResult = { application };
  if (Array.isArray(record.sessions)) {
    const sessions = record.sessions.filter(
      (item): item is string => typeof item === "string",
    );
    if (sessions.length > 0) result.sessions = sessions;
  }
  return result;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

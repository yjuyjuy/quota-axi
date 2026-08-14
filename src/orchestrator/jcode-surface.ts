import { execFileText } from "../lib/process.js";

/**
 * The jcode live-session control surface, abstracted behind a seam (ADR 0031,
 * Phase 1).
 *
 * `switch` actuates account moves by driving the jcode CLI as a subprocess:
 * `jcode session list --json` enumerates live sessions, and
 * `jcode session switch-account [<SESSION>] [--all] --account <A> [--model <M>]
 * --json` applies a move with drain semantics (applied immediately when the
 * session is idle, deferred to the session's next turn when a turn holds the
 * agent lock, never interrupting it). This module owns the process boundary and
 * pins to the CLI's real merged `--json` contract; the interface is the seam
 * unit tests mock so they never shell out to a real jcode.
 *
 * The `--json` shapes here match the merged jcode master surface (jcode PR #22):
 * `session list --json` emits a bare array of `session_id`-keyed rows, and
 * `session switch-account --json` emits a bare array of per-session outcomes
 * carrying `ok`, `deferred`, and `error`. The adapter preserves that per-session
 * fidelity so the switch core can report real failures and the applied/deferred
 * distinction rather than collapsing them.
 *
 * Phase 1 is account-only: {@link SwitchAccountRequest.model} exists so the
 * shape is ready for the Phase 2 model map, but the `switch` core never sets it
 * (rotation within the Claude pool never changes the model). The adapter passes
 * `--model` only if a caller explicitly provides one, so the account-only
 * invariant is enforced by the caller, not hidden here.
 */

/** One live session as `jcode session list --json` reports it (`SessionListRow`). */
export type JcodeLiveSession = {
  /** Session id (jcode `session_id`). */
  id: string;
  /** Optional human-readable session name. */
  name?: string;
  /** Provider the session runs on, for example `claude`. */
  provider?: string;
  /** Account the session currently runs on. */
  account?: string;
  /** Model the session currently runs on. */
  model?: string;
  /** Whether the session is currently processing a turn. */
  isProcessing?: boolean;
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

/**
 * One per-session outcome from `jcode session switch-account --json`
 * (`SessionSwitchOutcome`). `ok` is true when the switch applied OR was
 * accepted-and-queued; `deferred` is true when it was accepted but deferred to
 * the session's next turn (a turn was in flight); `error` carries the failure
 * reason when `ok` is false.
 */
export type SessionSwitchOutcome = {
  /** Session id the outcome is about (jcode `session_id`). */
  sessionId: string;
  /** True when the switch applied or was accepted-and-queued. */
  ok: boolean;
  /** Account now targeted, when jcode reports it. */
  account?: string;
  /** Model now targeted, present only when a model switch was requested. */
  model?: string;
  /** True when accepted but deferred to the session's next turn. */
  deferred: boolean;
  /** Failure reason, present when `ok` is false. */
  error?: string;
};

/** The `jcode session switch-account --json` result: per-session outcomes. */
export type SwitchAccountResult = {
  /** The per-session outcomes jcode reported, in order. */
  outcomes: SessionSwitchOutcome[];
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
 * `--model`. The single-session form passes the session as a POSITIONAL argument
 * (the real CLI shape); `--all` switches every session and is mutually exclusive
 * with a positional session.
 */
export function buildSwitchAccountArgs(
  request: SwitchAccountRequest,
): string[] {
  const args = ["session", "switch-account"];
  if (request.all) {
    args.push("--all");
  } else if (request.session !== undefined) {
    args.push(request.session);
  }
  args.push("--account", request.account);
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

/**
 * Parse `jcode session list --json`: a bare array of `session_id`-keyed rows
 * (`SessionListRow`). A row without a string `session_id` is dropped.
 */
export function parseSessionList(raw: string): JcodeLiveSession[] {
  const value = safeJson(raw);
  const list = Array.isArray(value) ? value : [];
  const out: JcodeLiveSession[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.session_id;
    if (typeof id !== "string") continue;
    const session: JcodeLiveSession = { id };
    if (typeof record.name === "string") session.name = record.name;
    if (typeof record.provider === "string") session.provider = record.provider;
    if (typeof record.account === "string") session.account = record.account;
    if (typeof record.model === "string") session.model = record.model;
    if (typeof record.is_processing === "boolean") {
      session.isProcessing = record.is_processing;
    }
    out.push(session);
  }
  return out;
}

/**
 * Parse `jcode session switch-account --json`: a bare array of per-session
 * outcomes (`SessionSwitchOutcome`). Each carries `session_id`, `ok`,
 * `deferred`, and an optional `error`/`account`/`model`.
 */
export function parseSwitchResult(raw: string): SwitchAccountResult {
  const value = safeJson(raw);
  const list = Array.isArray(value) ? value : [];
  const outcomes: SessionSwitchOutcome[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const sessionId =
      typeof record.session_id === "string" ? record.session_id : "";
    const outcome: SessionSwitchOutcome = {
      sessionId,
      ok: record.ok === true,
      deferred: record.deferred === true,
    };
    if (typeof record.account === "string") outcome.account = record.account;
    if (typeof record.model === "string") outcome.model = record.model;
    if (typeof record.error === "string") outcome.error = record.error;
    outcomes.push(outcome);
  }
  return { outcomes };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

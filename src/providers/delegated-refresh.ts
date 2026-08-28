import { spawn, type ChildProcess } from "node:child_process";
import { findCommandPath, terminateChild } from "../lib/process.js";
import type { SourceAttempt } from "../types.js";

/**
 * Delegated credential refresh.
 *
 * quota-axi never mints or rotates an OAuth credential itself, and never
 * performs a refresh-token exchange over HTTP. The reason is empirical: the
 * refresh tokens behind these stores rotate on use. Refreshing `~/.codex/auth.json`
 * out of band was observed to replace both the access token and the refresh
 * token, which would leave the vendor's own copy holding a spent refresh token
 * and force the user to sign in again. A quota reader must never be able to
 * sign a user out of the harness it is measuring.
 *
 * So only when the same stored access token is expired, has a refresh token
 * beside it, and is empirically rejected, quota-axi runs the vendor's own
 * smallest non-interactive command - the one that already owns rotation and
 * already owns the credential store - and then re-reads the refreshed access
 * token from the store the vendor just rewrote. quota-axi
 * reads the result; the vendor performs the rotation.
 *
 * The delegate contract, enforced here:
 *
 * - fixed argv resolved through `PATH` (or an absolute provider override).
 *   Delegates are declared in code, never assembled from provider responses,
 *   configuration, or user input, and never run through a shell. Deliberately
 *   shell-free resolution means a PATH-resolved Windows `.cmd` or `.bat` shim
 *   cannot run; that delegated attempt fails and the provider falls back to
 *   its existing read-only report and advice. The no-shell guarantee is never
 *   weakened to work around this accepted platform degradation.
 * - no interactive surface: the child gets no stdin (so a vendor TUI or prompt
 *   exits instead of waiting), `TERM=dumb`, and the vendor's own documented
 *   "do not open a browser" environment variables.
 * - a bounded wall-clock budget with SIGTERM/SIGKILL teardown.
 * - the child's output is drained and discarded. Credentials are never parsed
 *   out of vendor output; the refreshed value only ever comes from re-reading
 *   the vendor's own store.
 * - at most one delegated refresh per credential source per quota read, which
 *   each caller enforces by delegating only on its single recovery path. It is
 *   deliberately per read rather than per process, so a long-running `--tui`
 *   still recovers from a session that expires while it is up.
 *
 * Only providers whose vendor CLI has an established non-interactive rotation
 * command get a delegate. Providers without one stay read-only and keep their
 * existing honest advice.
 */

export type RefreshDelegate = {
  /** Attempt name recorded in `attempts` and `sourcesTried`. */
  source: string;
  /** Bare command resolved through `PATH`, or an absolute executable path. */
  command: string;
  /** Fixed non-interactive argv. Never built from untrusted input. */
  args: readonly string[];
  /** Wall-clock budget for the whole delegated run. */
  timeoutMs: number;
  /** Extra environment forced onto the child, merged last. */
  env?: Readonly<Record<string, string>>;
};

export type DelegatedRefreshRun =
  /** The vendor command completed; `exitCode` is diagnostic, not a verdict. */
  | { status: "ran"; exitCode: number | null }
  /** The vendor CLI is not installed, so there is nothing to delegate to. */
  | { status: "unavailable"; error: string }
  /** The command could not be started or exceeded its budget. */
  | { status: "failed"; error: string };

export const REFRESH_COMMAND_NOT_FOUND = "refresh_command_not_found";
export const REFRESH_SPAWN_FAILED = "refresh_spawn_failed";
export const REFRESH_TIMED_OUT = "refresh_timed_out";
export const REFRESH_EXIT_STATUS = "refresh_exit_status";

/**
 * Environment forced onto every delegated run. `NO_COLOR` and `TERM=dumb` keep
 * vendor output plain, and the remaining entries are the vendors' own opt-outs
 * for opening a browser. Combined with a closed stdin this keeps the delegated
 * command to a non-interactive rotation, never a sign-in flow.
 */
const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  TERM: "dumb",
  NO_BROWSER: "1",
  NO_OPEN_BROWSER: "1",
};

export async function runRefreshDelegate(
  delegate: RefreshDelegate,
): Promise<DelegatedRefreshRun> {
  const executable = await findCommandPath(delegate.command);
  if (!executable) {
    return { status: "unavailable", error: REFRESH_COMMAND_NOT_FOUND };
  }
  return new Promise<DelegatedRefreshRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...delegate.args], {
        // No stdin: a vendor command that would prompt exits instead of hanging.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...NON_INTERACTIVE_ENV, ...delegate.env },
      });
    } catch {
      resolve({ status: "failed", error: REFRESH_SPAWN_FAILED });
      return;
    }

    let settled = false;
    const settle = (run: DelegatedRefreshRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      terminateChild(child);
      settle({ status: "failed", error: REFRESH_TIMED_OUT });
    }, delegate.timeoutMs);

    // Drain and discard: the child must never block on a full pipe, and its
    // output is never a credential source.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", () =>
      settle({ status: "failed", error: REFRESH_SPAWN_FAILED }),
    );
    child.on("close", (exitCode) => settle({ status: "ran", exitCode }));
  });
}

/**
 * Run a delegate and re-read the vendor store it owns.
 *
 * The re-read happens whenever the command actually ran, including on a
 * non-zero exit: a vendor CLI can rotate its token and still exit non-zero for
 * an unrelated reason, and the re-read plus the caller's own retry is what
 * decides the outcome. The attempt record stays diagnostic.
 */
export async function delegateCredentialRefresh<S>(args: {
  delegate: RefreshDelegate;
  reread: () => S | Promise<S>;
}): Promise<{ attempt: SourceAttempt; state?: S }> {
  const run = await runRefreshDelegate(args.delegate);
  const attempt = refreshDelegateAttempt(args.delegate, run);
  if (run.status !== "ran") return { attempt };
  return { attempt, state: await args.reread() };
}

export function refreshDelegateAttempt(
  delegate: RefreshDelegate,
  run: DelegatedRefreshRun,
): SourceAttempt {
  if (run.status === "unavailable") {
    return { source: delegate.source, status: "skipped", error: run.error };
  }
  if (run.status === "failed") {
    return { source: delegate.source, status: "failed", error: run.error };
  }
  if (run.exitCode === 0) return { source: delegate.source, status: "success" };
  return {
    source: delegate.source,
    status: "failed",
    error: REFRESH_EXIT_STATUS,
  };
}

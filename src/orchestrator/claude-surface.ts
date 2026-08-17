import { execFileCapture } from "../lib/process.js";

/**
 * The Claude-harness account control surface, abstracted behind a seam
 * (ADR 0031, Phase 2).
 *
 * The Claude harness binding is GLOBAL: one account flip re-points every live
 * Claude session at once, with near-instant adoption and no restarts. quota-axi
 * does NOT write the Claude credential store itself. The store must have exactly
 * ONE writer, and claude-swap (cswap) already owns that store and encodes the
 * working switch mechanics (backup/restore of the live login plus live-session
 * adoption). So `switch` actuates a Claude-harness decision by shelling out to
 * cswap and never touches the store directly.
 *
 * The invocation is `cswap switch <target> --json`: a direct switch-to that
 * emits a schema-v1 JSON payload on stdout, exits 0 on success (or an
 * already-active no-op) and exits 1 with a JSON error envelope on a handled
 * failure. That path makes NO Anthropic usage-endpoint call (only cswap's
 * `list`/`status`/`auto`/dashboard surfaces poll usage, and those already
 * self-coalesce through cswap's own usage store), so driving it adds nothing to
 * the usage-endpoint request budget the Phase 1 shared cache protects.
 *
 * This module owns the process boundary and pins to cswap's real `--json`
 * contract; the {@link ClaudeHarnessSurface} interface is the seam unit tests
 * mock so they never shell out to a real cswap.
 */

/**
 * The outcome of actuating a Claude-harness account flip.
 *
 *   - `applied`: cswap moved the live login onto the target (every live Claude
 *     session adopts it without a restart).
 *   - `already-active`: the target was already the active account, so the
 *     desired end state already held. Reported distinctly but treated as a
 *     success by the switch core.
 *   - `failed`: cswap ran and reported a handled failure (its JSON error
 *     envelope), for example an unknown target.
 *   - `unavailable`: cswap is missing or could not be run at all (not
 *     scriptable). The switch core turns this into a fail-closed refusal.
 */
export type ClaudeSwitchOutcome =
  | { status: "applied"; target: string; account?: ClaudeAccountRef }
  | { status: "already-active"; target: string; account?: ClaudeAccountRef }
  | { status: "failed"; target: string; error: string }
  | { status: "unavailable"; target: string; error: string };

/** A minimal account reference as cswap reports it on a switch. */
export type ClaudeAccountRef = {
  number?: number;
  email?: string;
};

/**
 * The seam unit tests mock. A real implementation drives cswap; a fake records
 * calls and returns canned outcomes, so the switch core is tested without a
 * live cswap or a real credential store.
 */
export type ClaudeHarnessSurface = {
  /** Flip the global Claude account onto `target`, driving live-session adoption. */
  switchAccount(target: string): Promise<ClaudeSwitchOutcome>;
};

export type CswapSurfaceOptions = {
  /** cswap executable to run. Defaults to `cswap` on `PATH`. */
  binary?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Build the argv for `cswap switch <target> --json`. Kept pure and exported so
 * a test can assert the exact invocation. The target is the cswap account
 * selector (an alias, email, or slot number the operator maps to the registry
 * account); it is passed as a positional argument, and `--json` forces the
 * machine-readable, non-interactive contract.
 */
export function buildCswapSwitchArgs(target: string): string[] {
  return ["switch", target, "--json"];
}

/**
 * The real Claude-harness surface: drives cswap as a subprocess and parses its
 * `--json` output. This is intentionally the only place `switch` touches the
 * Claude credential store, and it does so through cswap (the store's single
 * writer) rather than writing the store directly. Unit tests replace the whole
 * object with a fake.
 */
export function createCswapSurface(
  options: CswapSurfaceOptions = {},
): ClaudeHarnessSurface {
  const binary = options.binary ?? "cswap";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async switchAccount(target: string): Promise<ClaudeSwitchOutcome> {
      let result: Awaited<ReturnType<typeof execFileCapture>>;
      try {
        result = await execFileCapture(
          binary,
          buildCswapSwitchArgs(target),
          timeoutMs,
        );
      } catch (error) {
        // The binary is missing or could not be run at all (ENOENT, permission,
        // timeout): cswap is not scriptable here, so fail closed rather than
        // half-switching.
        return {
          status: "unavailable",
          target,
          error: describeUnavailable(binary, error),
        };
      }
      return parseCswapSwitch(target, result.stdout, result.code);
    },
  };
}

/**
 * Parse `cswap switch <target> --json`. Kept pure and exported so a test can
 * pin the mapping from cswap's real JSON shapes onto {@link ClaudeSwitchOutcome}
 * without a subprocess.
 *
 * cswap's success payload carries `switched` (bool), `reason`, and `to`
 * (`{number,email}`); its handled-failure payload carries an `error`
 * (`{type,message}`). Output that cannot be parsed, or a non-zero exit with no
 * error envelope, is treated as a failure rather than a false success.
 */
export function parseCswapSwitch(
  target: string,
  stdout: string,
  code: number | null,
): ClaudeSwitchOutcome {
  const value = safeJson(stdout);
  if (value === undefined || value === null || typeof value !== "object") {
    return {
      status: "failed",
      target,
      error:
        code === 0
          ? "cswap switch produced no parseable JSON output"
          : `cswap switch exited ${code ?? "with a signal"} with no parseable JSON output`,
    };
  }
  const record = value as Record<string, unknown>;

  // A handled failure: cswap emits a JSON error envelope and exits non-zero.
  const errorField = record.error;
  if (errorField && typeof errorField === "object") {
    const message = (errorField as Record<string, unknown>).message;
    return {
      status: "failed",
      target,
      error:
        typeof message === "string" && message.length > 0
          ? message
          : "cswap switch reported an error",
    };
  }

  // A success payload. `switched: false` from a direct switch-to means the
  // target was already active (the desired end state already held).
  const account = parseAccountRef(record.to);
  const switched = record.switched === true;
  if (code !== 0) {
    // A success-shaped payload with a non-zero exit is contradictory: treat it
    // as a failure so a partial or ambiguous switch is never reported as done.
    return {
      status: "failed",
      target,
      error: `cswap switch exited ${code ?? "with a signal"}`,
    };
  }
  const base = account ? { target, account } : { target };
  return switched
    ? { status: "applied", ...base }
    : { status: "already-active", ...base };
}

function parseAccountRef(value: unknown): ClaudeAccountRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const ref: ClaudeAccountRef = {};
  if (typeof record.number === "number") ref.number = record.number;
  if (typeof record.email === "string") ref.email = record.email;
  if (ref.number === undefined && ref.email === undefined) return undefined;
  return ref;
}

function describeUnavailable(binary: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return `cswap (\`${binary}\`) is not installed or not on PATH`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `cswap (\`${binary}\`) could not be run: ${message}`;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

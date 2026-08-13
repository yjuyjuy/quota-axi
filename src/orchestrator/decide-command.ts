import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { collapseHome, readJsonFileResult } from "../lib/fs.js";
import { nowIso } from "../lib/time.js";
import {
  decide,
  type AccountObservation,
  type DecideRequest,
  type DecisionResponse,
  type SessionInput,
} from "./decide.js";
import { policyFilePath, registryFilePath } from "./paths.js";
import { validate } from "./validate.js";
import { readYamlFile } from "./yaml.js";

/**
 * `quota-axi decide`: the pure account-switch decider (ADR 0031, Phase 1).
 *
 * This command is READ-ONLY. It reads the account registry, the declarative
 * policy, and an observations file (per-account window telemetry), then emits a
 * versioned decision naming the chosen account per session and the reason chain
 * behind it. It performs ZERO side effects: it writes no store, switches
 * nothing, and never touches provider state. The mutating actuation is the
 * separate later `switch` verb.
 *
 * Observations are supplied as a file rather than fetched live because a live
 * per-account fetch would require resolving each account's distinct credential,
 * which is out of Phase 1 scope. The shape mirrors what a caller can build from
 * quota-axi's own live quota reports read through the shared usage cache.
 */

export type DecideFlags = {
  json: boolean;
  registryPath: string;
  policyPath: string;
  observationsPath: string;
};

export function parseDecideFlags(args: string[]): DecideFlags {
  let json = false;
  let registryPath: string | undefined;
  let policyPath: string | undefined;
  let observationsPath: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--registry") {
      registryPath = requireValue(args, ++index, "--registry");
      continue;
    }
    if (arg.startsWith("--registry=")) {
      registryPath = arg.slice("--registry=".length);
      continue;
    }
    if (arg === "--policy") {
      policyPath = requireValue(args, ++index, "--policy");
      continue;
    }
    if (arg.startsWith("--policy=")) {
      policyPath = arg.slice("--policy=".length);
      continue;
    }
    if (arg === "--observations") {
      observationsPath = requireValue(args, ++index, "--observations");
      continue;
    }
    if (arg.startsWith("--observations=")) {
      observationsPath = arg.slice("--observations=".length);
      continue;
    }
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `quota-axi decide --help` for supported flags",
    ]);
  }

  if (observationsPath === undefined) {
    throw new AxiError(
      "decide requires --observations <path>",
      "VALIDATION_ERROR",
      [
        "Pass --observations pointing at a JSON file of per-account window telemetry",
      ],
    );
  }

  return {
    json,
    registryPath: registryPath ?? registryFilePath(),
    policyPath: policyPath ?? policyFilePath(),
    observationsPath,
  };
}

export async function decideCommand(
  args: string[],
  _context?: unknown,
): Promise<string> {
  void _context;
  const flags = parseDecideFlags(args);

  const validation = validate(
    readYamlFile(flags.registryPath),
    readYamlFile(flags.policyPath),
  );
  if (!validation.valid || !validation.registry || !validation.policy) {
    process.exitCode = 1;
    const summary = {
      registry: collapseHome(flags.registryPath),
      policy: collapseHome(flags.policyPath),
      valid: false,
      issueCount: validation.issues.length,
    };
    if (flags.json) {
      return JSON.stringify(
        {
          generatedAt: nowIso(),
          ok: false,
          issues: validation.issues,
        },
        null,
        2,
      );
    }
    const rows = validation.issues.map((item) => ({
      file: item.file,
      path: item.path === "" ? "(root)" : item.path,
      code: item.code,
      message: item.message,
    }));
    return `${encode(summary)}\n${encode({ issues: rows })}`;
  }

  const observations = readObservations(flags.observationsPath);

  const request: DecideRequest = {
    registry: validation.registry,
    policy: validation.policy,
    observations: observations.observations,
    now: observations.now ?? nowIso(),
    ...(observations.sessions ? { sessions: observations.sessions } : {}),
    ...(observations.harness ? { harness: observations.harness } : {}),
    ...(observations.provider ? { provider: observations.provider } : {}),
  };

  const decision = decide(request);

  return flags.json
    ? JSON.stringify(decision, null, 2)
    : renderDecisionToon(flags, decision);
}

/** The observations file shape the CLI accepts. */
type ObservationsFile = {
  now?: string;
  harness?: string;
  provider?: string;
  sessions?: SessionInput[];
  observations: Record<string, AccountObservation>;
};

function readObservations(path: string): ObservationsFile {
  const result = readJsonFileResult(path);
  if (result.status === "missing") {
    throw new AxiError(
      `observations file not found: ${collapseHome(path)}`,
      "VALIDATION_ERROR",
    );
  }
  if (result.status === "invalid") {
    throw new AxiError(
      `observations file could not be parsed (${result.error})`,
      "VALIDATION_ERROR",
    );
  }
  const value = result.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AxiError(
      "observations file must be a JSON object with an `observations` map",
      "VALIDATION_ERROR",
    );
  }
  const record = value as Record<string, unknown>;
  const observations = record.observations;
  if (
    observations === null ||
    typeof observations !== "object" ||
    Array.isArray(observations)
  ) {
    throw new AxiError(
      "observations file must contain an `observations` object keyed by account id",
      "VALIDATION_ERROR",
    );
  }
  const file: ObservationsFile = {
    observations: observations as Record<string, AccountObservation>,
  };
  if (typeof record.now === "string") file.now = record.now;
  if (typeof record.harness === "string") file.harness = record.harness;
  if (typeof record.provider === "string") file.provider = record.provider;
  if (Array.isArray(record.sessions)) {
    file.sessions = record.sessions as SessionInput[];
  }
  return file;
}

function renderDecisionToon(
  flags: DecideFlags,
  decision: DecisionResponse,
): string {
  const summary = encode({
    registry: collapseHome(flags.registryPath),
    policy: collapseHome(flags.policyPath),
    schemaVersion: decision.schemaVersion,
    provider: decision.provider,
    harness: decision.harness,
    sessions: decision.decisions.length,
  });
  const rows = decision.decisions.map((item) => ({
    scope: item.scope,
    action: item.action,
    current: item.currentAccount ?? "(none)",
    chosen: item.chosenAccount ?? "(hold)",
    why: item.reasons.map((reason) => reason.code).join(" -> "),
  }));
  return `${summary}\n${encode({ decisions: rows })}`;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR", [
      `Pass ${flag}=... if the value begins with --`,
    ]);
  }
  return value;
}

import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { collapseHome } from "../lib/fs.js";
import { nowIso } from "../lib/time.js";
import { policyFilePath, registryFilePath } from "./paths.js";
import { PolicyStore } from "./store.js";
import type { ValidationIssue } from "./types.js";
import { validate } from "./validate.js";
import { readYamlFile } from "./yaml.js";

/**
 * `quota-axi validate`: check the account registry + declarative policy files
 * (ADR 0031, Phase 1) for schema and referential-integrity problems. Read-only
 * apart from refreshing the last-valid-policy fallback snapshot on success.
 */

export type ValidateFlags = {
  json: boolean;
  registryPath: string;
  policyPath: string;
};

export function parseValidateFlags(args: string[]): ValidateFlags {
  let json = false;
  let registryPath: string | undefined;
  let policyPath: string | undefined;

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
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `quota-axi validate --help` for supported flags",
    ]);
  }

  return {
    json,
    registryPath: registryPath ?? registryFilePath(),
    policyPath: policyPath ?? policyFilePath(),
  };
}

export async function validateCommand(
  args: string[],
  _context?: unknown,
): Promise<string> {
  void _context;
  const flags = parseValidateFlags(args);
  const result = validate(
    readYamlFile(flags.registryPath),
    readYamlFile(flags.policyPath),
  );

  // A valid pair refreshes the retained fallback; a bad edit never touches it.
  if (result.valid) {
    new PolicyStore({
      registryPath: flags.registryPath,
      policyPath: flags.policyPath,
    }).reload();
  }

  if (!result.valid) process.exitCode = 1;

  return flags.json
    ? JSON.stringify(jsonReport(flags, result.valid, result.issues), null, 2)
    : renderValidateToon(flags, result.valid, result.issues);
}

function jsonReport(
  flags: ValidateFlags,
  valid: boolean,
  issues: ValidationIssue[],
): {
  generatedAt: string;
  schemaVersion: 1;
  valid: boolean;
  registryPath: string;
  policyPath: string;
  issues: ValidationIssue[];
} {
  return {
    generatedAt: nowIso(),
    schemaVersion: 1,
    valid,
    registryPath: flags.registryPath,
    policyPath: flags.policyPath,
    issues,
  };
}

function renderValidateToon(
  flags: ValidateFlags,
  valid: boolean,
  issues: ValidationIssue[],
): string {
  const summary = encode({
    registry: collapseHome(flags.registryPath),
    policy: collapseHome(flags.policyPath),
    valid,
    issueCount: issues.length,
  });
  if (valid) {
    return `${summary}\nboth files are valid; last-valid policy fallback refreshed`;
  }
  const rows = issues.map((item) => ({
    file: item.file,
    path: item.path === "" ? "(root)" : item.path,
    code: item.code,
    message: item.message,
  }));
  return `${summary}\n${encode({ issues: rows })}`;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new AxiError(`${flag} requires a file path`, "VALIDATION_ERROR", [
      `Pass ${flag}=... if the value begins with --`,
    ]);
  }
  return value;
}

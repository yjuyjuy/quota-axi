import { readFileSync } from "node:fs";
import { load as loadYaml, YAMLException } from "js-yaml";

/**
 * Read and parse a YAML config file for the orchestrator. Mirrors the shape of
 * {@link readJsonFileResult} in `../lib/fs.ts`: a missing file, a malformed
 * file, and a well-formed file are three distinct, non-throwing outcomes so
 * the validator can turn each into an actionable issue.
 */
export type YamlFileReadResult =
  | { status: "success"; value: unknown }
  | { status: "missing" }
  | { status: "invalid"; error: string };

export function readYamlFile(file: string): YamlFileReadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "invalid", error: "file_read_error" };
  }
  try {
    return { status: "success", value: loadYaml(text) ?? null };
  } catch (error) {
    return {
      status: "invalid",
      error:
        error instanceof YAMLException
          ? `yaml_parse_error: ${error.reason}`
          : "yaml_parse_error",
    };
  }
}

function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

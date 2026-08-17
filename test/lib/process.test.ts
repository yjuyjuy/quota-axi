import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandExists,
  execFileCapture,
  terminateChild,
} from "../../src/lib/process.js";

const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
let tempDir: string | undefined;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPathExt === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = originalPathExt;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("commandExists", () => {
  it("finds executables from PATH without shell probes", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-path-"));
    const command = "quota-axi-fixture";
    const file =
      process.platform === "win32"
        ? join(tempDir, `${command}.CMD`)
        : join(tempDir, command);
    writeFileSync(
      file,
      process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
    );
    chmodSync(file, 0o700);
    process.env.PATH = tempDir;
    process.env.PATHEXT = ".CMD;.EXE";

    expect(await commandExists(command)).toBe(true);
    expect(await commandExists("quota-axi-missing")).toBe(false);
  });
});

describe("execFileCapture", () => {
  it.skipIf(process.platform === "win32")(
    "captures stdout and a non-zero exit without rejecting",
    async () => {
      const result = await execFileCapture(
        "/bin/sh",
        ["-c", "printf '%s' hello; exit 3"],
        5_000,
      );
      expect(result.stdout).toBe("hello");
      expect(result.code).toBe(3);
      expect(result.killed).toBe(false);
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "captures a clean exit",
    async () => {
      const result = await execFileCapture(
        "/bin/sh",
        ["-c", "printf ok"],
        5_000,
      );
      expect(result.stdout).toBe("ok");
      expect(result.code).toBe(0);
    },
    10_000,
  );

  it("rejects when the binary cannot be spawned at all (ENOENT)", async () => {
    await expect(
      execFileCapture("quota-axi-nonexistent-binary-xyz", [], 5_000),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("terminateChild", () => {
  it.skipIf(process.platform === "win32")(
    "force-kills a child that ignores SIGTERM",
    async () => {
      const child = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
      ]);
      await new Promise((resolve) => child.stdout?.once("data", resolve));
      terminateChild(child);
      const signal = await new Promise((resolve) =>
        child.once("exit", (_code, exitSignal) => resolve(exitSignal)),
      );
      expect(signal).toBe("SIGKILL");
    },
    10_000,
  );
});

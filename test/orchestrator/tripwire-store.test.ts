import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TripwireStore } from "../../src/orchestrator/tripwire-store.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function scratch(): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-tripwire-"));
  return join(tempDir, "tripwires.json");
}

describe("TripwireStore", () => {
  it("reads an empty map when the store does not exist", () => {
    const store = new TripwireStore({ path: scratch() });
    expect(store.read()).toEqual({});
  });

  it("records a tripwire and reads it back", () => {
    const path = scratch();
    const store = new TripwireStore({ path });
    store.record({
      "claude-max-primary": {
        exhaustedUntil: "2026-08-14T05:00:00.000Z",
        recordedAt: "2026-08-14T02:00:00.000Z",
        reason: "current_reserve_crossed",
      },
    });

    const roundTrip = new TripwireStore({ path }).read();
    expect(roundTrip["claude-max-primary"].exhaustedUntil).toBe(
      "2026-08-14T05:00:00.000Z",
    );
    expect(roundTrip["claude-max-primary"].reason).toBe(
      "current_reserve_crossed",
    );
  });

  it("merges into existing records without clobbering unrelated accounts", () => {
    const path = scratch();
    const store = new TripwireStore({ path });
    store.record({
      "account-a": {
        exhaustedUntil: "2026-08-14T05:00:00.000Z",
        recordedAt: "x",
      },
    });
    store.record({
      "account-b": {
        exhaustedUntil: "2026-08-14T06:00:00.000Z",
        recordedAt: "y",
      },
    });

    const all = new TripwireStore({ path }).read();
    expect(Object.keys(all).sort()).toEqual(["account-a", "account-b"]);
  });

  it("writes the store 0600", () => {
    const path = scratch();
    new TripwireStore({ path }).record({
      "account-a": {
        exhaustedUntil: "2026-08-14T05:00:00.000Z",
        recordedAt: "x",
      },
    });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns an empty map for a corrupt store rather than throwing", () => {
    const path = scratch();
    writeFileSync(path, "not json");
    expect(new TripwireStore({ path }).read()).toEqual({});
  });

  it("persists the versioned schema on disk", () => {
    const path = scratch();
    new TripwireStore({ path }).record({
      "account-a": {
        exhaustedUntil: "2026-08-14T05:00:00.000Z",
        recordedAt: "x",
      },
    });
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
    };
    expect(file.schemaVersion).toBe(1);
  });
});

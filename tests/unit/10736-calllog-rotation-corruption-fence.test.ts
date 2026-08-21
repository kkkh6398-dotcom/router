/**
 * #10736 — call-log rotation fail-closed fence on SQLite corruption.
 *
 * `rotateCallLogs()` previously swallowed a SQLITE_CORRUPT ("database disk image
 * is malformed") error and only logged it, so rotation kept firing against a
 * broken pager every ~60s and nothing surfaced the corruption. These tests pin
 * the narrow, root-cause-agnostic fix the maintainer scoped:
 *
 *   1. isSqliteCorruptionError classifies corruption vs. transient/logical errors.
 *   2. The fence state machine engages once, records the reason, and is resettable.
 *   3. runDbHealthCheck folds a live fence into an integrity_check_failed issue,
 *      flipping isHealthy to false (what /api/db/health reports).
 *
 * All pure/DB-free: the fence module imports nothing, and the health check is
 * exercised with a stub adapter, so no real SQLite file is needed.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  isSqliteCorruptionError,
  markCallLogRotationCorrupt,
  isCallLogRotationFenced,
  getCallLogRotationHealth,
  resetCallLogRotationHealth,
} from "../../src/lib/usage/callLogRotationHealth.ts";
import { runDbHealthCheck } from "../../src/lib/db/healthCheck.ts";
import type { SqliteAdapter } from "../../src/lib/db/adapters/types.ts";

describe("isSqliteCorruptionError", () => {
  it("matches the better-sqlite3 error code", () => {
    const err = Object.assign(new Error("something"), { code: "SQLITE_CORRUPT" });
    assert.equal(isSqliteCorruptionError(err), true);
  });

  it("matches the code case-insensitively and as a substring (e.g. SQLITE_CORRUPT_VTAB)", () => {
    const err = Object.assign(new Error("x"), { code: "sqlite_corrupt_vtab" });
    assert.equal(isSqliteCorruptionError(err), true);
  });

  it("matches the malformed message text when no code is present (node:sqlite / sql.js)", () => {
    assert.equal(
      isSqliteCorruptionError(new Error("database disk image is malformed")),
      true
    );
    assert.equal(
      isSqliteCorruptionError(new Error("database or disk is malformed")),
      true
    );
  });

  it("does NOT match transient or logical errors", () => {
    assert.equal(isSqliteCorruptionError(new Error("database is locked")), false);
    assert.equal(isSqliteCorruptionError(new Error("SQLITE_BUSY")), false);
    assert.equal(
      isSqliteCorruptionError(new Error("too many SQL variables")),
      false
    );
    assert.equal(
      isSqliteCorruptionError(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" })),
      false
    );
  });

  it("is defensive about non-Error throws", () => {
    assert.equal(isSqliteCorruptionError("database disk image is malformed"), true);
    assert.equal(isSqliteCorruptionError(null), false);
    assert.equal(isSqliteCorruptionError(undefined), false);
    assert.equal(isSqliteCorruptionError(42), false);
  });
});

describe("call-log rotation fence state machine", () => {
  beforeEach(() => resetCallLogRotationHealth());

  it("starts unfenced", () => {
    assert.equal(isCallLogRotationFenced(), false);
    const health = getCallLogRotationHealth();
    assert.deepEqual(health, { fenced: false, reason: null, fencedAt: null });
  });

  it("engages once and records the reason + timestamp", () => {
    markCallLogRotationCorrupt("database disk image is malformed");
    assert.equal(isCallLogRotationFenced(), true);
    const health = getCallLogRotationHealth();
    assert.equal(health.fenced, true);
    assert.equal(health.reason, "database disk image is malformed");
    assert.ok(health.fencedAt && !Number.isNaN(Date.parse(health.fencedAt)));
  });

  it("is idempotent: the first reason wins on repeated hits", () => {
    markCallLogRotationCorrupt("first cause");
    const firstAt = getCallLogRotationHealth().fencedAt;
    markCallLogRotationCorrupt("second cause");
    const health = getCallLogRotationHealth();
    assert.equal(health.reason, "first cause");
    assert.equal(health.fencedAt, firstAt);
  });

  it("falls back to a default reason when given an empty message", () => {
    markCallLogRotationCorrupt("   ");
    assert.equal(getCallLogRotationHealth().reason, "database disk image is malformed");
  });

  it("reset clears the fence (operator recovery / test isolation)", () => {
    markCallLogRotationCorrupt("boom");
    resetCallLogRotationHealth();
    assert.equal(isCallLogRotationFenced(), false);
    assert.deepEqual(getCallLogRotationHealth(), {
      fenced: false,
      reason: null,
      fencedAt: null,
    });
  });
});

/**
 * A minimal SQLite adapter stub: quick_check returns "ok" and every table reads
 * as empty, so runDbHealthCheck finds NO issues on its own. That isolates the
 * fence contribution — any issue in the result must come from the rotation fence.
 */
function makeHealthyStubDb(): SqliteAdapter {
  const emptyStmt = {
    get: () => undefined,
    all: () => [] as unknown[],
    run: () => ({ changes: 0 }),
  };
  return {
    driver: "better-sqlite3",
    name: "/tmp/stub.sqlite",
    open: true,
    prepare: () => emptyStmt,
    pragma: (sql: string) => {
      if (typeof sql === "string" && sql.includes("quick_check")) {
        return [{ quick_check: "ok" }];
      }
      return [];
    },
    exec: () => {},
    close: () => {},
  } as unknown as SqliteAdapter;
}

describe("runDbHealthCheck surfaces a live rotation fence (#10736)", () => {
  beforeEach(() => resetCallLogRotationHealth());

  it("is healthy when nothing is fenced", () => {
    const result = runDbHealthCheck(makeHealthyStubDb(), { autoRepair: false });
    assert.equal(result.isHealthy, true);
    assert.equal(
      result.issues.some((i) => i.table === "call_logs"),
      false
    );
  });

  it("flips to degraded with an integrity_check_failed issue once fenced", () => {
    markCallLogRotationCorrupt("database disk image is malformed");
    const result = runDbHealthCheck(makeHealthyStubDb(), { autoRepair: false });
    assert.equal(result.isHealthy, false);
    const issue = result.issues.find((i) => i.table === "call_logs");
    assert.ok(issue, "expected a call_logs health issue when rotation is fenced");
    assert.equal(issue!.type, "integrity_check_failed");
    assert.match(issue!.description, /database disk image is malformed/);
    assert.match(issue!.description, /restore the database/i);
  });

  it("reports the fence even when quick_check is skipped (slow-storage path)", () => {
    markCallLogRotationCorrupt("boom");
    const result = runDbHealthCheck(makeHealthyStubDb(), {
      autoRepair: false,
      skipIntegrityCheck: true,
    });
    assert.equal(result.isHealthy, false);
    assert.equal(
      result.issues.some((i) => i.table === "call_logs"),
      true
    );
  });

  it("does not auto-repair the fenced state (repairedCount stays 0)", () => {
    markCallLogRotationCorrupt("boom");
    const result = runDbHealthCheck(makeHealthyStubDb(), { autoRepair: true });
    assert.equal(result.repairedCount, 0);
    // Still degraded — the fence is not something the health check clears.
    assert.equal(result.isHealthy, false);
  });
});

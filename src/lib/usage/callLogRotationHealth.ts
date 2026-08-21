/**
 * Fail-closed fence for call-log rotation on SQLite corruption (#10736).
 *
 * `rotateCallLogs()` used to swallow a `SQLITE_CORRUPT` ("database disk image is
 * malformed") error and only log it. On a live single-writer file that means:
 *   - rotation keeps firing every ~60s against a pager that is already broken,
 *     re-issuing DELETEs through malformed pages and risking wider damage, and
 *   - nothing else in the process learns the primary DB is corrupt, so
 *     `/api/db/health` stays green while artifacts silently stop rotating.
 *
 * This module is the narrow, root-cause-agnostic fix the maintainer scoped on
 * the issue: detect the corruption signal, fence further rotation writes, and
 * expose a degraded flag the DB health check folds into its result. It does NOT
 * attempt repair — a live auto-`REINDEX`/`VACUUM` on a single-writer corrupt
 * file is worse than the current failure. Recovery stays a deliberate operator
 * action (restore from backup / recreate).
 *
 * Leaf module by design: it imports nothing, so both the rotation path and the
 * DB health-check path can depend on it without an import cycle.
 */

export interface CallLogRotationHealth {
  /** True once a corruption signal fenced rotation. Writes are held until reset. */
  fenced: boolean;
  /** The sanitized error message that triggered the fence, if any. */
  reason: string | null;
  /** ISO timestamp of when the fence engaged, if any. */
  fencedAt: string | null;
}

let fenced = false;
let reason: string | null = null;
let fencedAt: string | null = null;

/**
 * Whether an error thrown while touching SQLite indicates on-disk corruption
 * (`SQLITE_CORRUPT` / "database disk image is malformed"), as opposed to a
 * transient/logical failure (busy, constraint, too many variables, ...). Only
 * the corruption class should fence rotation; everything else stays a logged,
 * retried soft failure so we don't fence on an unrelated hiccup.
 *
 * Matches on both the better-sqlite3 error `code` and the message text so it
 * works across the driver cascade (better-sqlite3 sets `code`; node:sqlite /
 * sql.js surface the message), and is defensive about non-Error throws.
 */
export function isSqliteCorruptionError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  if (code.toUpperCase().includes("SQLITE_CORRUPT")) return true;

  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("database disk image is malformed") ||
    normalized.includes("database or disk is malformed") ||
    normalized.includes("sqlite_corrupt")
  );
}

/**
 * Engage the fence after a corruption signal. Idempotent: the first reason and
 * timestamp are kept so repeated hits during a single incident don't churn the
 * recorded cause.
 */
export function markCallLogRotationCorrupt(message: string): void {
  if (fenced) return;
  fenced = true;
  reason = message && message.trim().length > 0 ? message : "database disk image is malformed";
  fencedAt = new Date().toISOString();
}

/** True when rotation is fenced and must not touch the database. */
export function isCallLogRotationFenced(): boolean {
  return fenced;
}

/** Snapshot of the current fence state for health reporting. */
export function getCallLogRotationHealth(): CallLogRotationHealth {
  return { fenced, reason, fencedAt };
}

/**
 * Clear the fence. Intended for operator-driven recovery (after restoring a
 * known-good file) and for test isolation. Exported deliberately narrow.
 */
export function resetCallLogRotationHealth(): void {
  fenced = false;
  reason = null;
  fencedAt = null;
}

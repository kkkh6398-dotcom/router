/**
 * #10899 — OpenCode is served by two provider identities: the no-auth
 * "opencode" id (the connection card the user actually fills, storing the key
 * under provider="opencode") and the "opencode-zen" APIKEY gateway that the
 * model layer resolves the "opencode/<model>" prefix to.
 *
 * Before the fix, an auto-combo target resolving to "opencode-zen" searched
 * `provider_connections` for provider="opencode-zen" only, found nothing, and
 * dropped the target (503 ALL_TARGETS_SKIPPED) even though the user's key sits
 * on the "opencode" row. The fix adds ["opencode", "opencode-zen"] to
 * PROVIDER_SEARCH_PAIRS so a lookup under either id finds the other — same
 * operator account, requested id first (mirrors the existing nvidia/nvidia_nim
 * and antigravity/agy pairs).
 *
 * This pins the search-pair behavior against the real credential resolver and
 * the real connection-store API (createProviderConnection handles the schema +
 * key encryption; a raw SQL INSERT would drift from the store).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-10899-opencode-pair-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("getProviderCredentials('opencode-zen') resolves the API key stored under 'opencode'", async () => {
  // Seed an APIKEY connection under the "opencode" id (the card the user fills).
  await createProviderConnection({
    provider: "opencode",
    authType: "api-key",
    name: "opencode-account",
    isActive: true,
    apiKey: "test-opencode-key-10899",
  });

  // A target resolved to "opencode-zen" must find that key via the search pair.
  const creds = await getProviderCredentials("opencode-zen");

  assert.ok(creds, "expected credentials for an opencode-zen lookup backed by an opencode row");
  assert.equal((creds as { apiKey?: string }).apiKey, "test-opencode-key-10899");
});

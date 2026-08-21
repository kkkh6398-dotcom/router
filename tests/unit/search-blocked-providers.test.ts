// Regression coverage for the Blocked Providers security policy on the search
// surface (#10863 / upstream #10901). Settings -> Security -> Blocked Providers
// must be enforced on GET /v1/search (listing) and POST /v1/search (dispatch),
// the latter also backing the MCP omniroute_web_search tool, which fetches
// /v1/search internally.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-search-blocked-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "search-blocked-test-secret";

const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { GET, POST } = await import("../../src/app/api/v1/search/route.ts");

test("GET /v1/search excludes blocked search providers from the listing", async () => {
  await updateSettings({ blockedProviders: ["brave-search"] });

  const response = await GET();
  const data = (await response.json()) as { data: Array<{ id: string }> };

  const providerIds = data.data.map((p) => p.id);
  assert.equal(
    providerIds.includes("brave-search"),
    false,
    "a blocked provider must not be advertised in GET /v1/search"
  );
  // Sanity: the listing is not empty for unrelated providers (the filter is
  // scoped, not a blanket block).
  assert.ok(providerIds.length >= 1, "non-blocked providers should still be listed");
});

test("POST /v1/search rejects an explicitly blocked provider with 403", async () => {
  await updateSettings({ blockedProviders: ["brave-search"] });

  const req = new Request("http://localhost:20128/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "test query", provider: "brave-search" }),
  });

  const response = await POST(req);
  assert.equal(response.status, 403);
  const data = (await response.json()) as { error: { message: string } };
  assert.match(data.error.message, /blocked by security policy/i);
});

test("POST /v1/search still allows a non-blocked explicit provider past the block gate", async () => {
  // Only brave-search is blocked; a different explicit provider must not be
  // rejected by the security gate (it may fail later for missing credentials,
  // but it must NOT 403 on the blocked-provider check).
  await updateSettings({ blockedProviders: ["brave-search"] });

  const req = new Request("http://localhost:20128/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "test query", provider: "tavily" }),
  });

  const response = await POST(req);
  assert.notEqual(
    response.status,
    403,
    "a non-blocked provider must not be rejected by the blocked-provider gate"
  );
});

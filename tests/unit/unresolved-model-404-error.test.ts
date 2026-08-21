import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #10856/#10894: an unrecognized bare model id with a known vendor prefix
// (e.g. `claude-unrecognized-*`) must NOT be force-routed to that vendor's
// provider when the operator has not configured it. Previously
// resolveModelByProviderInference returned { provider: "anthropic" }
// unconditionally, so with only OpenAI/Gemini connections active the request
// was pinned to an unconfigured anthropic provider and failed with a misleading
// "[401] Missing API key" instead of a truthful model_not_found (404).
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-unresolved-model-404-"));
process.env.DATA_DIR = testDataDir;

const providersDb = await import("../../src/lib/db/providers.ts");
const model = await import("../../open-sse/services/model.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");

async function seedConnection(provider: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-conn`,
    apiKey: "sk-test",
  });
  invalidateDbCache("connections");
}

/** Type-safe read of the optional errorType discriminant on the resolver result. */
function errorTypeOf(result: unknown): string | undefined {
  return (result as { errorType?: string }).errorType;
}

test("unrecognized claude-* model returns model_not_found when anthropic is not active", async () => {
  // Only OpenAI is configured; anthropic is NOT in activeProviders.
  await seedConnection("openai");

  const result = await model.getModelInfoCore("claude-unrecognized-model-xyz", {});

  assert.equal(result.provider, null, "must not be force-routed to the unconfigured anthropic provider");
  assert.equal(
    errorTypeOf(result),
    "model_not_found",
    "an unresolvable model must classify as model_not_found, not a misleading auth error"
  );
});

test("unrecognized gemini-* model returns model_not_found when gemini is not active", async () => {
  const result = await model.getModelInfoCore("gemini-unrecognized-model-xyz", {});
  assert.equal(result.provider, null);
  assert.equal(errorTypeOf(result), "model_not_found");
});

test("claude-* still routes to anthropic when anthropic IS active (no regression)", async () => {
  await seedConnection("anthropic");

  const result = await model.getModelInfoCore("claude-unrecognized-model-xyz", {});
  assert.equal(
    result.provider,
    "anthropic",
    "with anthropic active, prefix inference must still route Claude models to it"
  );
  assert.equal(errorTypeOf(result), undefined);
});

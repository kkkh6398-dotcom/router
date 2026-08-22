import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getProviderErrorRuleMatch,
  setOperatorProviderErrorRules,
  providerRuleRegistry,
  type OperatorProviderErrorRule,
} from "../../open-sse/config/providerErrorRules.ts";

describe("operator error rules", () => {
  beforeEach(() => {
    // Isolate each test from the settings-backed cache.
    setOperatorProviderErrorRules(undefined);
  });

  it("operator rule overrides the catalog registry for a provider", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      nvidia: [
        { status: 404, match: "Not found for account", scope: "model", cooldownMs: 1000 },
      ],
    };
    const m = getProviderErrorRuleMatch("nvidia", 404, null, "Not found for account id 123", op);
    assert.ok(m, "operator rule should match");
    assert.equal(m.scope, "model");
    assert.equal(m.cooldownMs, 1000);
  });

  it("operator rule wins even when a catalog rule would also match", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      openrouter: [{ status: 402, match: "credits exhausted", scope: "model" }],
    };
    const m = getProviderErrorRuleMatch("openrouter", 402, null, "credits exhausted on key", op);
    assert.ok(m);
    // Catalog rule for openrouter/402 uses scope "connection"; the operator
    // override must take precedence.
    assert.equal(m.scope, "model");
  });

  it("operator can reclassify a 401 before the global permanent rule", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      acme: [{ status: 401, match: "transient quota", scope: "connection", reason: "quota_exhausted" }],
    };
    const m = getProviderErrorRuleMatch("acme", 401, null, "transient quota — retry shortly", op);
    assert.ok(m);
    assert.equal(m.scope, "connection");
    assert.equal(m.reason, "quota_exhausted");
  });

  it("unknown provider with no operator rule returns null (no throw)", () => {
    const m = getProviderErrorRuleMatch("unknown-provider", 402, null, "anything");
    assert.equal(m, null);
  });

  it("substring match is case-insensitive", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      nvidia: [{ status: 404, match: "NOT FOUND", scope: "model" }],
    };
    const m = getProviderErrorRuleMatch("nvidia", 404, null, "Body says Not Found Here", op);
    assert.ok(m);
    assert.equal(m.scope, "model");
  });

  it("status must match before the substring is considered", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      nvidia: [{ status: 404, match: "not found", scope: "model" }],
    };
    // 500 with the same body text must NOT match a 404 rule.
    const m = getProviderErrorRuleMatch("nvidia", 500, null, "not found for account", op);
    assert.equal(m, null);
  });

  it("without an operator override the catalog registry is intact", () => {
    const m = getProviderErrorRuleMatch("openrouter", 402, null, "credits exhausted on key");
    assert.ok(m);
    assert.equal(m.scope, "connection");
    assert.equal(m.cooldownMs, 2 * 60 * 1000);
  });

  it("reads the settings-backed cache via setOperatorProviderErrorRules", () => {
    setOperatorProviderErrorRules({
      nvidia: [{ status: 404, match: "Not found", scope: "model" }],
    });
    const m = getProviderErrorRuleMatch("nvidia", 404, null, "Not found for account");
    assert.ok(m);
    assert.equal(m.scope, "model");
    // Provider key lookup is case-insensitive.
    const m2 = getProviderErrorRuleMatch("NVIDIA", 404, null, "Not found here");
    assert.ok(m2);
    assert.equal(m2.scope, "model");
  });

  describe("proven catalog rules (no operator override)", () => {
    const cases: Array<[string, number, string, string]> = [
      ["nvidia", 404, "model id not found", "model"],
      ["huggingface", 400, "model does not exist", "model"],
    ];
    for (const [provider, status, body, scope] of cases) {
      it(`catalog ${provider} ${status} with '${body}' resolves to scope ${scope}`, () => {
        assert.ok(providerRuleRegistry.has(provider), "provider should be registered");
        const m = getProviderErrorRuleMatch(provider, status, null, body);
        assert.ok(m, "catalog rule should match");
        assert.equal(m.scope, scope);
      });
    }
  });
});

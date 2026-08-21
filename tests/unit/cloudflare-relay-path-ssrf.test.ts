// SSRF regression guard for the Cloudflare relay worker (lockstep with the Deno
// Deploy / Vercel relay fixes; upstream PR #4643 follow-up, #10935).
//
// The generated Cloudflare Worker reads an attacker-controlled `x-relay-path`
// header and previously appended it to the (validated) `x-relay-target` origin
// via string concatenation: `fetch(targetBase + relayPath)` where
// `targetBase = target.endsWith("/") ? target.slice(0, -1) : target`. That is
// bypassable via userinfo (`/x@evil.com`), a backslash (`\evil.com`), or a
// protocol-relative path (`//evil.com/x`) — the same hole the Deno and Vercel
// workers had before #4643. The Cloudflare generator missed the fix because it
// was ported separately from upstream decolua/9router PR #1360.
//
// The fix reuses the SAME pure `resolveRelayTarget()` guard (exported from the
// deno-deploy route, embedded into all three workers via Function#toString).
// This mirrors `vercel-deploy-relay-path-ssrf.test.ts`: the pure-function
// behavior is covered once in the deno test (same function); here we focus on
// the Cloudflare worker wiring, and pin that the embedded guard survives a
// minifier that mangles the source function's own name (#6149).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRelayTarget } from "../../src/app/api/settings/proxy/deno-deploy/route";
import { buildCloudflareWorkerScript } from "../../src/lib/proxyRelay/cloudflareWorkerScript";

const TARGET = "https://api.anthropic.com";
const RELAY_AUTH = "deadbeefcafe";

describe("cloudflare relay reuses the SSRF-safe resolveRelayTarget guard", () => {
  it("accepts a legitimate absolute path", () => {
    const r = resolveRelayTarget(TARGET, "/v1/foo");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.url, "https://api.anthropic.com/v1/foo");
  });

  it("rejects //evil.com/x (host swap)", () => {
    const r = resolveRelayTarget(TARGET, "//evil.com/x");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it("rejects /x@evil.com (userinfo)", () => {
    const r = resolveRelayTarget(TARGET, "/x@evil.com");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it("rejects \\evil.com (backslash)", () => {
    const r = resolveRelayTarget(TARGET, "\\evil.com");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it("rejects a value without a leading '/'", () => {
    const r = resolveRelayTarget(TARGET, "evil.com/x");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });
});

describe("buildCloudflareWorkerScript — generated worker has no string-concat SSRF hole", () => {
  it("does not append relayPath to target by string concatenation", () => {
    const worker = buildCloudflareWorkerScript(RELAY_AUTH);
    // Match the actual concatenated-fetch pattern, not the substring "+ relayPath"
    // (which also appears in the explanatory comment describing the old hole).
    assert.ok(
      !/fetch\(\s*targetBase\s*\+\s*relayPath/.test(worker),
      "Cloudflare worker must not fetch `targetBase + relayPath` (string-concat SSRF)"
    );
    assert.ok(
      !/const\s+targetBase\s*=/.test(worker),
      "Cloudflare worker must not derive the old `targetBase` concatenation base"
    );
  });

  it("embeds the resolveRelayTarget guard and fetches the resolved url", () => {
    const worker = buildCloudflareWorkerScript(RELAY_AUTH);
    assert.ok(
      worker.includes("const resolveRelayTarget ="),
      "the Cloudflare worker must embed the shared resolveRelayTarget guard under a literal const"
    );
    assert.ok(
      worker.includes("resolveRelayTarget(target, relayPath)"),
      "the Cloudflare worker must call the shared resolveRelayTarget guard"
    );
    assert.ok(
      worker.includes("await fetch(resolved.url"),
      "the Cloudflare worker must fetch the SSRF-validated resolved url"
    );
  });

  it("keeps the embedded guard intact when the source function is minifier-renamed", () => {
    // #6149: the SWC-minified standalone build can rename the SOURCE
    // resolveRelayTarget function; the worker binds it to a LITERAL const name at
    // the call site so it still resolves. Simulate the rename by re-evaluating the
    // emitted worker source with the function's own name mangled, and assert the
    // literal `const resolveRelayTarget =` binding (and thus the call site) holds.
    const worker = buildCloudflareWorkerScript(RELAY_AUTH);
    const mangled = worker.replace(/function resolveRelayTarget\b/g, "function _rrt_$0");
    assert.ok(
      mangled.includes("const resolveRelayTarget ="),
      "the literal const binding must survive a source-function rename"
    );
    assert.ok(
      mangled.includes("resolveRelayTarget(target, relayPath)"),
      "the hardcoded call site must still resolve after a source-function rename"
    );
  });

  it("still ships the private/loopback target guard and auth check", () => {
    const worker = buildCloudflareWorkerScript(RELAY_AUTH);
    assert.ok(
      worker.includes("isPrivateHostname"),
      "the private/loopback SSRF guard must be preserved"
    );
    assert.ok(
      worker.includes("x-relay-auth"),
      "the relay auth check must be preserved"
    );
  });
});

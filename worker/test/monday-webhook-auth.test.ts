import { describe, it, expect } from "vitest";
import { mondayAuth } from "../src/webhooks";
import type { Env } from "../src/types";

/**
 * monday board webhooks carry NO cryptographic signature unless the hook was created with an
 * INTEGRATION APP's OAuth token — confirmed against current monday documentation. Ours were created
 * with a personal API token, so /webhooks/monday had ZERO authentication: an anonymous POST could
 * drive the reconciler, and after the delete/restore work it could also force syncs and destroy
 * restore metadata for arbitrary ids.
 *
 * `MONDAY_SIGNING_SECRET` sat in Env from the beginning, read by no code, describing a mechanism that
 * cannot exist for these hooks. It has been replaced by something that actually runs.
 *
 * The interim control is a CAPABILITY URL. It is a shared secret rather than a signature — a URL can
 * leak through proxy logs, and it proves only "the caller knows the secret", never "monday sent this".
 * JWT via OAuth remains the production follow-up; this is what is deployable without an OAuth
 * round-trip, and it closes the open door today.
 */

const KEY = "cb8e8ed9138582f9a5fbce9530e43e0176273ee7a16912b33c9f5cbb218befb2";
const env = (k?: string) => ({ MONDAY_WEBHOOK_KEY: k }) as unknown as Env;
const at = (path: string) => new URL(`https://w.example.com${path}`);

describe("the live Work-Management Worker must be unaffected", () => {
  // THE CRITICAL CASE. handleMonday is SHARED by both deployments. WM's hooks are registered at the
  // bare path and WM sets no key; if this check were unconditional, deploying it would have taken the
  // live WM sync offline instantly — every board event 401'd.
  it("fails OPEN when no key is configured, on the bare path", () => {
    expect(mondayAuth(at("/webhooks/monday"), env(undefined))).toMatchObject({ ok: true, reason: "unconfigured" });
    expect(mondayAuth(at("/webhooks/monday"), env(""))).toMatchObject({ ok: true });
    expect(mondayAuth(at("/webhooks/monday"), env("   "))).toMatchObject({ ok: true });
  });

  it("fails open regardless of what the caller presents, when unconfigured", () => {
    for (const p of ["/webhooks/monday", "/webhooks/monday/anything", "/webhooks/monday?k=junk"])
      expect(mondayAuth(at(p), env(undefined)).ok).toBe(true);
  });
});

describe("a second key (MONDAY_WEBHOOK_KEY_2) can be live beside the first", () => {
  const KEY2 = "0f".repeat(32);
  const both = { MONDAY_WEBHOOK_KEY: KEY, MONDAY_WEBHOOK_KEY_2: KEY2 } as unknown as Env;
  it("accepts either key, so old hooks and new hooks both work", () => {
    expect(mondayAuth(at(`/webhooks/monday/${KEY}`), both).ok).toBe(true);
    expect(mondayAuth(at(`/webhooks/monday/${KEY2}`), both).ok).toBe(true);
  });
  it("still refuses a wrong key and the bare path", () => {
    expect(mondayAuth(at(`/webhooks/monday/${KEY2.slice(0, -1)}x`), both)).toMatchObject({ ok: false, reason: "bad-key" });
    expect(mondayAuth(at("/webhooks/monday"), both)).toMatchObject({ ok: false, reason: "missing-key" });
  });
  it("only the second key set is still configured: it fails closed, never open", () => {
    const only2 = { MONDAY_WEBHOOK_KEY_2: KEY2 } as unknown as Env;
    expect(mondayAuth(at("/webhooks/monday"), only2).ok).toBe(false);
    expect(mondayAuth(at(`/webhooks/monday/${KEY2}`), only2).ok).toBe(true);
  });
});

describe("the CRM Worker, with a key configured, fails CLOSED", () => {
  it("accepts the exact key as a path segment", () =>
    expect(mondayAuth(at(`/webhooks/monday/${KEY}`), env(KEY)))
      .toMatchObject({ ok: true, reason: "path-key" }));

  it("tolerates a trailing slash", () =>
    expect(mondayAuth(at(`/webhooks/monday/${KEY}/`), env(KEY)).ok).toBe(true));

  it("also accepts the key as a ?k= query parameter", () =>
    expect(mondayAuth(at(`/webhooks/monday?k=${KEY}`), env(KEY)))
      .toMatchObject({ ok: true, reason: "query-key" }));

  it("REFUSES the bare path — the old unauthenticated entry point", () =>
    expect(mondayAuth(at("/webhooks/monday"), env(KEY)))
      .toMatchObject({ ok: false, reason: "missing-key" }));

  it("REFUSES a wrong, truncated, extended or empty key", () => {
    for (const bad of ["", "x", KEY.slice(0, -1), `${KEY}x`, KEY.toUpperCase(), KEY.replace("c", "d")])
      expect(mondayAuth(at(`/webhooks/monday/${bad}`), env(KEY)).ok).toBe(false);
  });

  it("distinguishes a missing key from a wrong one, for the log", () => {
    expect(mondayAuth(at("/webhooks/monday"), env(KEY)).reason).toBe("missing-key");
    expect(mondayAuth(at("/webhooks/monday/nope"), env(KEY)).reason).toBe("bad-key");
  });

  // A deeper path is not the registered hook, so it must not authenticate — the regex is anchored and
  // allows exactly one segment.
  it("REFUSES a key buried in a deeper path", () => {
    expect(mondayAuth(at(`/webhooks/monday/${KEY}/extra`), env(KEY)).ok).toBe(false);
    expect(mondayAuth(at(`/webhooks/monday/x/${KEY}`), env(KEY)).ok).toBe(false);
  });

  it("handles a percent-encoded key, since it travels in a URL", () =>
    expect(mondayAuth(at(`/webhooks/monday/${encodeURIComponent(KEY)}`), env(KEY)).ok).toBe(true));

  // The comparison is length-checked then constant-time, so a wrong key of the right length must not
  // be distinguishable by timing. Behaviourally: still refused.
  it("refuses a same-length key that differs in one character", () => {
    const near = `${KEY.slice(0, -1)}${KEY.endsWith("2") ? "3" : "2"}`;
    expect(near.length).toBe(KEY.length);
    expect(mondayAuth(at(`/webhooks/monday/${near}`), env(KEY)).ok).toBe(false);
  });

  it("ignores an unrelated query string when the path key is right", () =>
    expect(mondayAuth(at(`/webhooks/monday/${KEY}?foo=bar`), env(KEY)).ok).toBe(true));
});

describe("the dead config it replaces", () => {
  // MONDAY_SIGNING_SECRET described a JWT check that cannot exist for personal-token hooks and was
  // read by nothing. Keeping the name would have implied a control that does not run.
  // readCODE, not readSource: webhooks.ts deliberately still NAMES the old field in a comment, to
  // record what was replaced and why. Forbidding the word outright would punish documenting it —
  // what must be gone is the Env declaration and any code that reads it.
  it("MONDAY_SIGNING_SECRET is gone from executable code and from the Env type", async () => {
    const { readSource, readCode } = await import("../scripts/read-source.mjs");
    for (const f of ["types.ts", "webhooks.ts", "index.ts"])
      expect(readCode(f)).not.toContain("MONDAY_SIGNING_SECRET");
    // types.ts must not mention it at all — a stale Env field advertises a control that never runs.
    expect(readSource("types.ts")).not.toContain("MONDAY_SIGNING_SECRET");
    expect(readSource("types.ts")).toContain("MONDAY_WEBHOOK_KEY");
  });

  it("and the false route comment is gone — monday had no signature to be guarded by", async () => {
    const { readSource } = await import("../scripts/read-source.mjs");
    expect(readSource("index.ts")).not.toContain("guarded by the challenge/signature inside");
  });
});

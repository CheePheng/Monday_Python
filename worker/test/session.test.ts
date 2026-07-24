import { describe, it, expect, beforeAll } from "vitest";
import { verifySessionToken } from "../src/session";

const SECRET = "test-signing-secret";
const ACCOUNT = "12345";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sign(payload: object, secret = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;

describe("verifySessionToken", () => {
  it("accepts a valid token and returns account/user id (nested dat)", async () => {
    const tok = await sign({ exp: future(), dat: { account_id: 12345, user_id: 678 } });
    const r = await verifySessionToken(SECRET, tok, ACCOUNT, Date.now());
    expect(r).toEqual({ ok: true, reason: "valid", accountId: "12345", userId: "678" });
  });
  it("accepts flat accountId/userId claims", async () => {
    const tok = await sign({ exp: future(), accountId: 12345, userId: 678 });
    const r = await verifySessionToken(SECRET, tok, ACCOUNT, Date.now());
    expect(r.ok).toBe(true);
    expect(r.accountId).toBe("12345");
  });
  it("rejects a wrong signature", async () => {
    const tok = await sign({ exp: future(), dat: { account_id: 12345, user_id: 1 } }, "other-secret");
    const r = await verifySessionToken(SECRET, tok, ACCOUNT, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature mismatch");
  });
  it("rejects an expired token", async () => {
    const tok = await sign({ exp: past(), dat: { account_id: 12345, user_id: 1 } });
    const r = await verifySessionToken(SECRET, tok, ACCOUNT, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("expired");
  });
  it("rejects a token from a different account", async () => {
    const tok = await sign({ exp: future(), dat: { account_id: 99999, user_id: 1 } });
    const r = await verifySessionToken(SECRET, tok, ACCOUNT, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("account not allowed");
  });
  it("rejects a token missing account/user claim", async () => {
    const tok = await sign({ exp: future() });
    const r = await verifySessionToken(SECRET, tok, ACCOUNT, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing account/user claim");
  });
  it("rejects a tampered payload (signature no longer matches)", async () => {
    const tok = await sign({ exp: future(), dat: { account_id: 12345, user_id: 1 } });
    const [h, , s] = tok.split(".");
    // Swap in a DIFFERENT (still valid-JSON) payload but keep the original signature: the classic
    // "escalate my account_id without re-signing" attack must be caught by the signature check.
    const forged = b64url(new TextEncoder().encode(
      JSON.stringify({ exp: future(), dat: { account_id: 99999, user_id: 1 } })));
    const r = await verifySessionToken(SECRET, `${h}.${forged}.${s}`, ACCOUNT, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature mismatch");
  });
  it("rejects a malformed token", async () => {
    const r = await verifySessionToken(SECRET, "not.a.jwt", ACCOUNT, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("malformed token");
  });
  it("rejects when no secret is configured", async () => {
    const tok = await sign({ exp: future(), dat: { account_id: 12345, user_id: 1 } });
    const r = await verifySessionToken("", tok, ACCOUNT, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no session secret configured");
  });
});

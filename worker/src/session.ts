// Verifies a monday Board View sessionToken (client-side `monday.get("sessionToken")`), a HS256 JWT.
// Pure + deterministic (nowMs is passed in) so it is fully unit-testable. Reads account/user id from
// either the nested `dat` object or flat top-level claims (monday token shapes vary by SDK version).
export interface SessionVerdict { ok: boolean; reason: string; accountId?: string; userId?: string }

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Pick account/user id from nested `dat` or flat claims; always returned as strings. */
function claim(payload: any, keys: string[]): string | undefined {
  const dat = payload?.dat ?? {};
  for (const k of keys) {
    const v = payload?.[k] ?? dat?.[k];
    if (v != null && v !== "") return String(v);
  }
  return undefined;
}

export async function verifySessionToken(
  secret: string, token: string, allowedAccountId: string | undefined, nowMs: number,
): Promise<SessionVerdict> {
  if (!secret) return { ok: false, reason: "no session secret configured" };
  const parts = (token || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [h, p, s] = parts;

  let payload: any;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))); }
  catch { return { ok: false, reason: "malformed token" }; }

  // Verify HS256 signature over `${header}.${payload}`.
  let expected: string;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`));
    expected = bytesToB64url(new Uint8Array(sig));
  } catch { return { ok: false, reason: "malformed token" }; }
  if (expected !== s) return { ok: false, reason: "signature mismatch" };

  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return { ok: false, reason: "expired" };

  const accountId = claim(payload, ["accountId", "account_id"]);
  const userId = claim(payload, ["userId", "user_id"]);
  if (!accountId || !userId) return { ok: false, reason: "missing account/user claim" };
  if (allowedAccountId && accountId !== String(allowedAccountId))
    return { ok: false, reason: "account not allowed" };

  return { ok: true, reason: "valid", accountId, userId };
}

# monday "Deal Cockpit" App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A monday Board View app (React, hosted by monday) that lets sales users browse/search deals, create a deal, and edit a deal (fields + contact/company associations + line items + updates) directly on the "Hubspot Deals" board — writing to the board while the existing Cloudflare Worker mirrors everything to HubSpot.

**Architecture:** Two phases in one repo. **Phase 1 (Worker backend):** verify the monday session-token JWT on `/app/*`, and add three id-keyed, session-authed endpoints — line-item update, line-item delete, association delete — so the editor's edit/remove actions propagate to HubSpot. **Phase 2 (React app):** a new `monday-app/` Vite+React+TS project using `@vibe/core` + `monday-sdk-js`; it reads/writes the board via `monday.api()` (seamless auth) and calls the Worker (with the session token) for HubSpot search + the three edit/remove endpoints. All correctness-critical logic is extracted into pure functions built test-first; monday/HubSpot I/O and UI rendering follow the existing repo pattern (pure logic unit-tested, I/O verified live).

**Tech Stack:** TypeScript, Cloudflare Workers (`wrangler`, `vitest`), Web Crypto (HS256 JWT verify); React 18, Vite, `@vibe/core`, `@vibe/icons`, `monday-sdk-js`, `vitest`; `@mondaycom/apps-cli` (`mapps code:push`) for deployment.

**Spec:** `docs/superpowers/specs/2026-07-11-monday-deal-cockpit-app-design.md` (rev 2).

---

## Board / HubSpot constants (single source of truth for the app)

Deals board `5029480547`. Columns: name→item name; Pipeline `color_mm4ws6k`; Deal Stage `color_mm53fh1r`; Vendors `dropdown_mm4n4f7r`; Amount `numeric_mm531t6e`; Currency `color_mm53vk99`; Close Date `date_mm53ecz3`; Sales Users `multiple_person_mm532m82`; Deal Owner `person`; Deal Type `color_mm53cky8`; Priority `color_mm532rej`; Associated Company `board_relation_mm54rrj3`→`5029639440`; Associated Contact `board_relation_mm5417sy`→`5029639630`; HubSpot Deal ID `numeric_mm4nz332` (read-only). Unassigned group `group_mm53yk6d`. Stage groups (title↔id): `group_mm4nf6fw` Appointment Scheduled, `group_title` Qualified To Buy, `group_mm4pa9zg` Presentation Scheduled, `group_mm4pbazz` Decision Maker Bought-In, `group_mm4pavfa` Contract Sent, `group_mm4py571` Closed Won, `group_mm4pw6e2` Closed Lost, `group_mm4pdres` (custom stage `2831885024`).
Subitems board `5029480548`: HubSpot Line Item ID `text_mm53ds6w`; HubSpot Product ID `text_mm54hbvj`; Unit Price `numeric_mm53rsfd`; Quantity `numeric_mm531345`; Net Price `numeric_mm538yj9`; Currency `text_mm538b8k`; Description `long_text_mm53a511`.
Contact board `5029639630`, HubSpot-id column `numeric_mm4xw7rk`. Company board `5029639440`, HubSpot-id column `numeric_mm4xkk3a`.
**All HubSpot ids are strings everywhere — never `Number()` them.**

---

# PHASE 1 — Worker backend

## Task 1: monday session-token verification (pure, TDD)

**Files:**
- Create: `worker/src/session.ts`
- Test: `worker/test/session.test.ts`
- Modify: `worker/src/types.ts` (add two env vars)

- [ ] **Step 1: Add env vars** — in `worker/src/types.ts`, inside `interface Env`, after the `APP_SECRET?` line add:

```typescript
  MONDAY_APP_SESSION_SECRET?: string; // signs the monday Board View sessionToken JWT (verify empirically: Client vs Signing secret)
  MONDAY_ACCOUNT_ID?: string;         // the one allowed monday account id (rejects tokens from any other account)
```

- [ ] **Step 2: Write the failing test** — `worker/test/session.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run, expect fail** — `cd worker && npx vitest run test/session.test.ts`
Expected: FAIL — cannot find module `../src/session`.

- [ ] **Step 4: Implement** — `worker/src/session.ts`:

```typescript
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
```

- [ ] **Step 5: Run, expect pass** — `cd worker && npx vitest run test/session.test.ts` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/session.ts worker/test/session.test.ts worker/src/types.ts
git commit -m "feat(worker): verify monday session-token JWT (HS256, exp, account, user)"
```

---

## Task 2: HubSpot line-item + association edit helpers

**Files:**
- Modify: `worker/src/hubspot.ts` (append three helpers next to `createLineItem`/`putAssociation`)

These follow the existing dry-run-guarded, `retries`-bounded pattern. They operate strictly by HubSpot id. No unit test (the repo unit-tests only pure functions; these fetch wrappers are verified live in Task 9), matching the existing `createLineItem`/`putAssociation` convention.

- [ ] **Step 1: Add `patchLineItem`** — in `worker/src/hubspot.ts`, immediately after `createLineItem` (ends ~line 108):

```typescript
/** Update an existing HubSpot line item by id (qty/price/etc.). retries=3 (PATCH is idempotent). */
export async function patchLineItem(env: Env, lineItemId: string,
    properties: Record<string, string>, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot PATCH line_item ${lineItemId}: ${JSON.stringify(properties)}`);
    return false;
  }
  await hs(env, "PATCH", `/crm/v3/objects/line_items/${lineItemId}`, { properties }, 3);
  console.log(`hubspot PATCH line_item ${lineItemId}: ${Object.keys(properties).join(",")}`);
  return true;
}

/** Delete a HubSpot line item by id (archive). retries=3 (DELETE is idempotent). 404 -> already gone. */
export async function deleteLineItem(env: Env, lineItemId: string, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot DELETE line_item ${lineItemId}`);
    return false;
  }
  try {
    await hs(env, "DELETE", `/crm/v3/objects/line_items/${lineItemId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot DELETE line_item ${lineItemId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot DELETE line_item ${lineItemId}`);
  return true;
}
```

- [ ] **Step 2: Add `deleteAssociation`** — immediately after `putAssociation` (ends ~line 92):

```typescript
/** Remove a DEFAULT association between two records (reverse of putAssociation). Idempotent; 404 -> gone. */
export async function deleteAssociation(env: Env, fromObject: string, fromId: string,
    toObject: string, toId: string, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot UNASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
    return false;
  }
  try {
    await hs(env, "DELETE",
      `/crm/v4/objects/${fromObject}/${fromId}/associations/${toObject}/${toId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot UNASSOC ${fromObject}/${fromId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot UNASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
  return true;
}
```

- [ ] **Step 3: Type-check** — `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/hubspot.ts
git commit -m "feat(worker): HubSpot patch/delete line-item + delete-association helpers"
```

---

## Task 3: `/app/*` session-token auth + edit/remove endpoints

**Files:**
- Modify: `worker/src/index.ts`
- Create: `worker/src/app-routes.ts` (request parsing/validation — the pure, testable part)
- Test: `worker/test/app-routes.test.ts`

The pure body-parsing/validation lives in `app-routes.ts` (TDD). `index.ts` wires auth + calls the HubSpot helpers.

- [ ] **Step 1: Write the failing test** — `worker/test/app-routes.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseLineItemBody, parseAssociationBody } from "../src/app-routes";

describe("parseLineItemBody", () => {
  it("update: requires lineItemId + non-empty properties", () =>
    expect(parseLineItemBody("PATCH", { lineItemId: "42", properties: { price: "10" } }))
      .toEqual({ ok: true, lineItemId: "42", properties: { price: "10" } }));
  it("update: rejects empty properties", () =>
    expect(parseLineItemBody("PATCH", { lineItemId: "42", properties: {} }).ok).toBe(false));
  it("delete: requires only lineItemId", () =>
    expect(parseLineItemBody("DELETE", { lineItemId: "42" }))
      .toEqual({ ok: true, lineItemId: "42", properties: undefined }));
  it("rejects a missing/numeric-only-invalid id", () => {
    expect(parseLineItemBody("DELETE", {}).ok).toBe(false);
    expect(parseLineItemBody("DELETE", { lineItemId: "abc" }).ok).toBe(false);
  });
});

describe("parseAssociationBody", () => {
  const good = { fromObject: "deals", fromId: "1", toObject: "contacts", toId: "2" };
  it("accepts a valid deals->contacts/companies body", () =>
    expect(parseAssociationBody(good)).toEqual({ ok: true, ...good }));
  it("rejects an unknown object type", () =>
    expect(parseAssociationBody({ ...good, toObject: "tickets" }).ok).toBe(false));
  it("rejects a non-numeric id", () =>
    expect(parseAssociationBody({ ...good, toId: "x" }).ok).toBe(false));
});
```

- [ ] **Step 2: Run, expect fail** — `cd worker && npx vitest run test/app-routes.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `worker/src/app-routes.ts`:

```typescript
// Pure request-body validation for the app's edit/remove endpoints. All ids are strings and must be
// numeric (HubSpot ids). Kept separate from index.ts so it is unit-testable without a live request.
const numeric = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const FROM_OK = new Set(["deals"]);
const TO_OK = new Set(["contacts", "companies"]);

export interface LineItemReq { ok: boolean; lineItemId?: string; properties?: Record<string, string>; error?: string }
export function parseLineItemBody(method: string, body: any): LineItemReq {
  const lineItemId = body?.lineItemId;
  if (!numeric(lineItemId)) return { ok: false, error: "lineItemId must be a numeric string" };
  if (method === "PATCH") {
    const properties = body?.properties;
    if (!properties || typeof properties !== "object" || Object.keys(properties).length === 0)
      return { ok: false, error: "properties required for update" };
    return { ok: true, lineItemId, properties };
  }
  return { ok: true, lineItemId, properties: undefined };
}

export interface AssocReq { ok: boolean; fromObject?: string; fromId?: string; toObject?: string; toId?: string; error?: string }
export function parseAssociationBody(body: any): AssocReq {
  const { fromObject, fromId, toObject, toId } = body ?? {};
  if (!FROM_OK.has(fromObject)) return { ok: false, error: "fromObject must be deals" };
  if (!TO_OK.has(toObject)) return { ok: false, error: "toObject must be contacts|companies" };
  if (!numeric(fromId) || !numeric(toId)) return { ok: false, error: "fromId/toId must be numeric strings" };
  return { ok: true, fromObject, fromId, toObject, toId };
}
```

- [ ] **Step 4: Run, expect pass** — `cd worker && npx vitest run test/app-routes.test.ts` → all PASS.

- [ ] **Step 5: Wire the routes in `index.ts`** — replace the imports, CORS block, and `/app/search` block.

Replace the top imports (lines 1-4) with:

```typescript
import type { Env, RunOpts } from "./types";
import { runAll, runIncremental } from "./sync";
import { handleHubspot, handleMonday } from "./webhooks";
import { searchObjects, patchLineItem, deleteLineItem, deleteAssociation } from "./hubspot";
import { verifySessionToken } from "./session";
import { parseLineItemBody, parseAssociationBody } from "./app-routes";
```

Replace the `CORS` const (lines 6-10) with:

```typescript
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-Trigger-Secret, Content-Type",
};

// Writes for real when the Worker is live (mirrors optsFromEnv but with a small per-request budget).
function appWriteOpts(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  return { dryRun: !live, writeHubspot: live, maxWrites: 5 };
}

// Auth for /app/*: a valid monday session token (browser) OR X-Trigger-Secret (server-to-server).
// The old static X-App-Secret path is retired (it was exposed in frontend prompt material).
async function authApp(req: Request, env: Env): Promise<{ ok: boolean; reason: string }> {
  const trigger = req.headers.get("x-trigger-secret");
  if (trigger && env.TRIGGER_SECRET && trigger === env.TRIGGER_SECRET) return { ok: true, reason: "trigger-secret" };
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false, reason: "no session token / trigger secret" };
  const v = await verifySessionToken(env.MONDAY_APP_SESSION_SECRET ?? "", bearer, env.MONDAY_ACCOUNT_ID, Date.now());
  return { ok: v.ok, reason: v.reason };
}
```

Replace the entire `/app/search` block (old lines 45-64) with the auth-gated search + the two new endpoints:

```typescript
    // App API (browser Board View app, cross-origin). Auth: monday session token or X-Trigger-Secret.
    if (url.pathname.startsWith("/app/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const auth = await authApp(req, env);
      if (!auth.ok) {
        console.log(`[app] path=${url.pathname} action=rejected reason="${auth.reason}"`);
        return new Response("forbidden", { status: 403, headers: CORS });
      }

      // GET /app/search?type=contacts|companies|products&q=&limit=
      if (url.pathname === "/app/search" && req.method === "GET") {
        const type = url.searchParams.get("type") ?? "";
        if (!["contacts", "companies", "products"].includes(type))
          return Response.json({ error: "type must be contacts|companies|products" }, { status: 400, headers: CORS });
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? "10");
        try {
          const results = await searchObjects(env, type, q, Number.isFinite(limit) ? limit : 10);
          return Response.json({ results }, { headers: CORS });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/search] type=${type} error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], error: scope ? "scope" : "search-failed" }, { headers: CORS });
        }
      }

      // POST /app/line-item {lineItemId, properties}  |  DELETE /app/line-item {lineItemId}
      if (url.pathname === "/app/line-item" && (req.method === "POST" || req.method === "DELETE")) {
        const body = await req.json().catch(() => ({}));
        const p = parseLineItemBody(req.method === "POST" ? "PATCH" : "DELETE", body);
        if (!p.ok) return Response.json({ error: p.error }, { status: 400, headers: CORS });
        try {
          if (req.method === "POST") await patchLineItem(env, p.lineItemId!, p.properties!, appWriteOpts(env));
          else await deleteLineItem(env, p.lineItemId!, appWriteOpts(env));
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/line-item] ${req.method} ${p.lineItemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
        }
      }

      // DELETE /app/association {fromObject, fromId, toObject, toId}
      if (url.pathname === "/app/association" && req.method === "DELETE") {
        const body = await req.json().catch(() => ({}));
        const a = parseAssociationBody(body);
        if (!a.ok) return Response.json({ error: a.error }, { status: 400, headers: CORS });
        try {
          await deleteAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env));
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/association] ${a.fromId}->${a.toId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
        }
      }

      return new Response("not found", { status: 404, headers: CORS });
    }
```

- [ ] **Step 6: Type-check + full test run** — `cd worker && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests (existing + session + app-routes) PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/index.ts worker/src/app-routes.ts worker/test/app-routes.test.ts
git commit -m "feat(worker): session-authed /app/* with line-item + association edit/remove endpoints"
```

- [ ] **Step 8: Set the new secrets (manual — the user runs these; do NOT put values in the repo)**

```bash
# Verify empirically FIRST which secret signs the sessionToken (see Task 10, Step 2), then:
cd worker && npx wrangler secret put MONDAY_APP_SESSION_SECRET
npx wrangler secret put MONDAY_ACCOUNT_ID   # the DKM monday account id
npx wrangler deploy
```

---

# PHASE 2 — monday "Deal Cockpit" React app

## Task 4: Scaffold `monday-app/`

**Files:**
- Create: `monday-app/package.json`, `monday-app/tsconfig.json`, `monday-app/vite.config.ts`, `monday-app/vitest.config.ts`, `monday-app/index.html`, `monday-app/src/main.tsx`, `monday-app/src/App.tsx`, `monday-app/.gitignore`

- [ ] **Step 1: `monday-app/package.json`**

```json
{
  "name": "monday-deal-cockpit",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@vibe/core": "^3",
    "@vibe/icons": "^1",
    "monday-sdk-js": "^0.5.6",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: `monday-app/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `monday-app/vite.config.ts`** — relative base so the bundle works under monday's hosting path:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist" },
});
```

- [ ] **Step 4: `monday-app/vitest.config.ts`** — Node env for the pure-logic tests:

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
```

- [ ] **Step 5: `monday-app/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Deal Cockpit</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: `monday-app/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 7: `monday-app/src/App.tsx`** — minimal placeholder (real routing added in Task 13):

```tsx
export default function App() {
  return <div>Deal Cockpit — loading…</div>;
}
```

- [ ] **Step 8: `monday-app/.gitignore`**

```
node_modules/
dist/
.mapps/
```

- [ ] **Step 9: Install + build + test** — `cd monday-app && npm install && npm run build && npm run test`
Expected: install succeeds; build produces `dist/`; `vitest` reports "No test files found" (fine — tests arrive next tasks).

- [ ] **Step 10: Commit**

```bash
git add monday-app/package.json monday-app/tsconfig.json monday-app/vite.config.ts monday-app/vitest.config.ts monday-app/index.html monday-app/src/main.tsx monday-app/src/App.tsx monday-app/.gitignore
git commit -m "chore(monday-app): scaffold Vite+React+TS Board View app"
```

---

## Task 5: Board config module

**Files:**
- Create: `monday-app/src/board-config.ts`

- [ ] **Step 1: Write the config** (mirrors the constants at the top of this plan; the expected-schema list drives Task 8's validation):

```typescript
// Single source of truth for board/column ids the app reads and writes. HubSpot ids are strings.
export const WORKER_BASE = "https://hubspot-monday-sync.askada.workers.dev";

export const DEALS_BOARD = "5029480547";
export const SUBITEMS_BOARD = "5029480548";
export const CONTACT_BOARD = "5029639630";
export const COMPANY_BOARD = "5029639440";

export const UNASSIGNED_GROUP = "group_mm53yk6d";
export const CONTACT_ID_COL = "numeric_mm4xw7rk"; // HubSpot id on the Contact board
export const COMPANY_ID_COL = "numeric_mm4xkk3a"; // HubSpot id on the Company board

// Deal columns. `kind` = expected monday column type (for schema validation).
export const DEAL_COLS = {
  hubspotDealId: { id: "numeric_mm4nz332", kind: "numeric" },   // read-only (Worker stamps it)
  pipeline:      { id: "color_mm4ws6k",   kind: "status" },
  stage:         { id: "color_mm53fh1r",  kind: "status" },
  vendors:       { id: "dropdown_mm4n4f7r", kind: "dropdown" },
  amount:        { id: "numeric_mm531t6e", kind: "numeric" },
  currency:      { id: "color_mm53vk99",  kind: "status" },
  closeDate:     { id: "date_mm53ecz3",   kind: "date" },
  salesUsers:    { id: "multiple_person_mm532m82", kind: "multiple-person" },
  dealOwner:     { id: "person",          kind: "multiple-person" },
  dealType:      { id: "color_mm53cky8",  kind: "status" },
  priority:      { id: "color_mm532rej",  kind: "status" },
  company:       { id: "board_relation_mm54rrj3", kind: "board-relation", boardId: COMPANY_BOARD },
  contact:       { id: "board_relation_mm5417sy", kind: "board-relation", boardId: CONTACT_BOARD },
} as const;

// Subitem (line item) columns.
export const SUB_COLS = {
  lineItemId: { id: "text_mm53ds6w",       kind: "text" },      // HubSpot Line Item ID (dedup key, read-only)
  productId:  { id: "text_mm54hbvj",       kind: "text" },      // HubSpot Product ID
  unitPrice:  { id: "numeric_mm53rsfd",    kind: "numeric" },
  quantity:   { id: "numeric_mm531345",    kind: "numeric" },
  netPrice:   { id: "numeric_mm538yj9",    kind: "numeric" },
  currency:   { id: "text_mm538b8k",       kind: "text" },
  description:{ id: "long_text_mm53a511",  kind: "long-text" },
} as const;

export interface ColSpec { id: string; kind: string; boardId?: string }
```

- [ ] **Step 2: Type-check** — `cd monday-app && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit** — `git add monday-app/src/board-config.ts && git commit -m "feat(monday-app): board/column config"`

---

## Task 6: `columns.ts` — form → monday column_values (pure, TDD)

**Files:**
- Create: `monday-app/src/lib/columns.ts`
- Test: `monday-app/src/lib/columns.test.ts`

- [ ] **Step 1: Write the failing test** — `monday-app/src/lib/columns.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { dealFormToColumnValues, lineItemToSubitemColumns, boardRelationValue, peopleValue } from "./columns";

describe("dealFormToColumnValues", () => {
  it("encodes each column type and skips empty fields", () => {
    const cv = dealFormToColumnValues({
      amount: "5000", currency: "USD", closeDate: "2026-07-01",
      stage: "Appointment Scheduled", dealType: "", priority: "High",
      vendors: ["Acme"], salesUserIds: ["111", "222"],
    });
    expect(cv).toEqual({
      numeric_mm531t6e: "5000",
      color_mm53vk99: { label: "USD" },
      date_mm53ecz3: { date: "2026-07-01" },
      color_mm53fh1r: { label: "Appointment Scheduled" },
      color_mm532rej: { label: "High" },
      dropdown_mm4n4f7r: { labels: ["Acme"] },
      multiple_person_mm532m82: { personsAndTeams: [{ id: 111, kind: "person" }, { id: 222, kind: "person" }] },
    });
  });
  it("omits keys entirely when their value is empty/absent", () => {
    const cv = dealFormToColumnValues({ amount: "", salesUserIds: [] });
    expect(cv).toEqual({});
  });
});

describe("peopleValue", () => {
  it("maps string ids to numeric person entries", () =>
    expect(peopleValue(["7", "8"])).toEqual({ personsAndTeams: [{ id: 7, kind: "person" }, { id: 8, kind: "person" }] }));
});

describe("boardRelationValue", () => {
  it("wraps numeric item ids", () =>
    expect(boardRelationValue(["101", "102"])).toEqual({ item_ids: [101, 102] }));
});

describe("lineItemToSubitemColumns", () => {
  it("maps price/qty/product id/currency and skips blanks", () =>
    expect(lineItemToSubitemColumns({ unitPrice: "100", quantity: "2", productId: "9", currency: "USD", description: "" }))
      .toEqual({ numeric_mm53rsfd: "100", numeric_mm531345: "2", text_mm54hbvj: "9", text_mm538b8k: "USD" }));
});
```

- [ ] **Step 2: Run, expect fail** — `cd monday-app && npx vitest run src/lib/columns.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `monday-app/src/lib/columns.ts`:

```typescript
import { DEAL_COLS, SUB_COLS } from "../board-config";

/** monday people value from string user ids (ids must be numeric for monday). */
export function peopleValue(ids: string[]): { personsAndTeams: { id: number; kind: "person" }[] } {
  return { personsAndTeams: ids.filter(Boolean).map(id => ({ id: Number(id), kind: "person" as const })) };
}
/** monday Connect-Boards value from linked monday item ids. */
export function boardRelationValue(itemIds: string[]): { item_ids: number[] } {
  return { item_ids: itemIds.filter(Boolean).map(id => Number(id)) };
}

export interface DealForm {
  amount?: string; currency?: string; closeDate?: string; stage?: string;
  dealType?: string; priority?: string; vendors?: string[]; salesUserIds?: string[];
}

/** Deal form -> monday column_values object (JSON-encode before sending). Empty fields are omitted so
 * an edit never blanks an untouched column. Note: item name (dealname) and group are set separately. */
export function dealFormToColumnValues(f: DealForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (f.amount) cv[DEAL_COLS.amount.id] = f.amount;
  if (f.currency) cv[DEAL_COLS.currency.id] = { label: f.currency };
  if (f.closeDate) cv[DEAL_COLS.closeDate.id] = { date: f.closeDate };
  if (f.stage) cv[DEAL_COLS.stage.id] = { label: f.stage };
  if (f.dealType) cv[DEAL_COLS.dealType.id] = { label: f.dealType };
  if (f.priority) cv[DEAL_COLS.priority.id] = { label: f.priority };
  if (f.vendors && f.vendors.length) cv[DEAL_COLS.vendors.id] = { labels: f.vendors };
  if (f.salesUserIds && f.salesUserIds.length) cv[DEAL_COLS.salesUsers.id] = peopleValue(f.salesUserIds);
  return cv;
}

export interface LineItemForm {
  unitPrice?: string; quantity?: string; productId?: string; currency?: string; description?: string;
}
/** Line-item form -> subitem column_values (blanks omitted). */
export function lineItemToSubitemColumns(li: LineItemForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (li.unitPrice) cv[SUB_COLS.unitPrice.id] = li.unitPrice;
  if (li.quantity) cv[SUB_COLS.quantity.id] = li.quantity;
  if (li.productId) cv[SUB_COLS.productId.id] = li.productId;
  if (li.currency) cv[SUB_COLS.currency.id] = li.currency;
  if (li.description) cv[SUB_COLS.description.id] = { text: li.description };
  return cv;
}
```

- [ ] **Step 4: Run, expect pass** — `cd monday-app && npx vitest run src/lib/columns.test.ts` → all PASS.

- [ ] **Step 5: Commit** — `git add monday-app/src/lib/columns.ts monday-app/src/lib/columns.test.ts && git commit -m "feat(monday-app): pure form->column_values encoders"`

---

## Task 7: `stage.ts` — stage⇄group derived from live groups (pure, TDD)

**Files:**
- Create: `monday-app/src/lib/stage.ts`
- Test: `monday-app/src/lib/stage.test.ts`

Stages are derived from the board's groups (title↔id) so nothing but the Unassigned bucket is hardcoded. Create/edit places the item in the chosen stage's group; the Worker reverses group→dealstage.

- [ ] **Step 1: Failing test** — `monday-app/src/lib/stage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { stageOptions, groupIdForStage, stageForGroupId } from "./stage";

const GROUPS = [
  { id: "group_mm4nf6fw", title: "Appointment Scheduled" },
  { id: "group_mm4py571", title: "Closed Won" },
  { id: "group_mm53yk6d", title: "Unassigned Deals" },
];

describe("stage helpers", () => {
  it("stageOptions excludes the Unassigned group", () =>
    expect(stageOptions(GROUPS)).toEqual(["Appointment Scheduled", "Closed Won"]));
  it("groupIdForStage maps a stage title to its group id", () =>
    expect(groupIdForStage("Closed Won", GROUPS)).toBe("group_mm4py571"));
  it("groupIdForStage returns undefined for an unknown stage", () =>
    expect(groupIdForStage("Nope", GROUPS)).toBeUndefined());
  it("stageForGroupId maps a group id back to its title", () =>
    expect(stageForGroupId("group_mm4nf6fw", GROUPS)).toBe("Appointment Scheduled"));
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — `monday-app/src/lib/stage.ts`:

```typescript
import { UNASSIGNED_GROUP } from "../board-config";

export interface Group { id: string; title: string }

/** Selectable stage titles = every group except the no-sales-user "Unassigned" bucket. */
export function stageOptions(groups: Group[]): string[] {
  return groups.filter(g => g.id !== UNASSIGNED_GROUP).map(g => g.title);
}
export function groupIdForStage(stage: string, groups: Group[]): string | undefined {
  return groups.find(g => g.title === stage && g.id !== UNASSIGNED_GROUP)?.id;
}
export function stageForGroupId(groupId: string, groups: Group[]): string | undefined {
  return groups.find(g => g.id === groupId)?.title;
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git add monday-app/src/lib/stage.* && git commit -m "feat(monday-app): stage<->group helpers from live groups"`

---

## Task 8: `schema.ts` — startup board-schema validation (pure, TDD)

**Files:**
- Create: `monday-app/src/lib/schema.ts`
- Test: `monday-app/src/lib/schema.test.ts`

- [ ] **Step 1: Failing test** — `monday-app/src/lib/schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateBoardSchema } from "./schema";

// monday `columns { id type }` shape. Board-relation type in monday is "board_relation".
const OK_COLS = [
  { id: "numeric_mm4nz332", type: "numeric" }, { id: "color_mm4ws6k", type: "status" },
  { id: "color_mm53fh1r", type: "status" }, { id: "dropdown_mm4n4f7r", type: "dropdown" },
  { id: "numeric_mm531t6e", type: "numeric" }, { id: "color_mm53vk99", type: "status" },
  { id: "date_mm53ecz3", type: "date" }, { id: "multiple_person_mm532m82", type: "multiple-person" },
  { id: "person", type: "multiple-person" }, { id: "color_mm53cky8", type: "status" },
  { id: "color_mm532rej", type: "status" }, { id: "board_relation_mm54rrj3", type: "board_relation" },
  { id: "board_relation_mm5417sy", type: "board_relation" },
];
const OK_GROUPS = [{ id: "group_mm53yk6d", title: "Unassigned Deals" }, { id: "group_mm4nf6fw", title: "Appointment Scheduled" }];

describe("validateBoardSchema", () => {
  it("passes when all deal columns + unassigned group are present with correct types", () =>
    expect(validateBoardSchema(OK_COLS, OK_GROUPS)).toEqual({ ok: true, errors: [] }));
  it("flags a missing column", () => {
    const r = validateBoardSchema(OK_COLS.filter(c => c.id !== "numeric_mm531t6e"), OK_GROUPS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("numeric_mm531t6e");
  });
  it("flags a wrong column type", () => {
    const bad = OK_COLS.map(c => c.id === "color_mm53fh1r" ? { ...c, type: "text" } : c);
    const r = validateBoardSchema(bad, OK_GROUPS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/color_mm53fh1r.*expected status.*got text/);
  });
  it("flags a missing Unassigned group", () => {
    const r = validateBoardSchema(OK_COLS, [{ id: "group_mm4nf6fw", title: "Appointment Scheduled" }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("Unassigned");
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — `monday-app/src/lib/schema.ts`:

```typescript
import { DEAL_COLS, UNASSIGNED_GROUP, type ColSpec } from "../board-config";

// monday column `type` strings for each expected `kind`. board-relation reports "board_relation";
// numeric->"numeric"; status->"status"; dropdown->"dropdown"; date->"date"; people->"multiple-person".
const KIND_TO_MONDAY_TYPE: Record<string, string> = {
  numeric: "numeric", status: "status", dropdown: "dropdown", date: "date",
  "multiple-person": "multiple-person", "board-relation": "board_relation", text: "text", "long-text": "long-text",
};

export interface SchemaResult { ok: boolean; errors: string[] }

/** Confirm every configured Deal column exists with the right type, and the Unassigned group exists.
 * Pure: takes monday `columns {id type}` and `groups {id title}` arrays. */
export function validateBoardSchema(
  columns: { id: string; type: string }[],
  groups: { id: string; title: string }[],
): SchemaResult {
  const byId = new Map(columns.map(c => [c.id, c.type]));
  const errors: string[] = [];
  for (const spec of Object.values(DEAL_COLS) as ColSpec[]) {
    const actual = byId.get(spec.id);
    const want = KIND_TO_MONDAY_TYPE[spec.kind] ?? spec.kind;
    if (actual === undefined) errors.push(`missing column ${spec.id} (expected ${want})`);
    else if (actual !== want) errors.push(`column ${spec.id}: expected ${want}, got ${actual}`);
  }
  if (!groups.some(g => g.id === UNASSIGNED_GROUP))
    errors.push(`missing Unassigned group ${UNASSIGNED_GROUP}`);
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run, expect pass.** (If a real monday `type` string differs from the assumptions above, Task 14's live load will surface it; fix `KIND_TO_MONDAY_TYPE` then.)
- [ ] **Step 5: Commit** — `git add monday-app/src/lib/schema.* && git commit -m "feat(monday-app): startup board-schema validation"`

---

## Task 9: `filter.ts` — deal table filtering (pure, TDD)

**Files:**
- Create: `monday-app/src/lib/filter.ts`
- Test: `monday-app/src/lib/filter.test.ts`

- [ ] **Step 1: Failing test** — `monday-app/src/lib/filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { filterDeals, type DealRow } from "./filter";

const ROWS: DealRow[] = [
  { id: "1", name: "Acme Renewal", stage: "Contract Sent", salesUserIds: ["111"] },
  { id: "2", name: "Beta Expansion", stage: "Closed Won", salesUserIds: ["222"] },
  { id: "3", name: "Acme Upsell", stage: "Contract Sent", salesUserIds: ["111", "333"] },
];

describe("filterDeals", () => {
  it("no filters -> all rows", () =>
    expect(filterDeals(ROWS, {}).map(r => r.id)).toEqual(["1", "2", "3"]));
  it("text query matches name (case-insensitive)", () =>
    expect(filterDeals(ROWS, { q: "acme" }).map(r => r.id)).toEqual(["1", "3"]));
  it("stage filter", () =>
    expect(filterDeals(ROWS, { stage: "Closed Won" }).map(r => r.id)).toEqual(["2"]));
  it("mine filter uses myUserId membership", () =>
    expect(filterDeals(ROWS, { mine: true, myUserId: "111" }).map(r => r.id)).toEqual(["1", "3"]));
  it("filters combine (AND)", () =>
    expect(filterDeals(ROWS, { q: "acme", mine: true, myUserId: "333" }).map(r => r.id)).toEqual(["3"]));
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — `monday-app/src/lib/filter.ts`:

```typescript
export interface DealRow {
  id: string; name: string; stage: string; salesUserIds: string[];
  amount?: string; currency?: string; closeDate?: string; company?: string; contact?: string;
}
export interface DealFilter { q?: string; stage?: string; mine?: boolean; myUserId?: string }

/** Filter deal rows for the table. All active filters must match (AND). Pure. */
export function filterDeals(rows: DealRow[], f: DealFilter): DealRow[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter(r => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (f.stage && r.stage !== f.stage) return false;
    if (f.mine && f.myUserId && !r.salesUserIds.includes(f.myUserId)) return false;
    return true;
  });
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git add monday-app/src/lib/filter.* && git commit -m "feat(monday-app): pure deal-table filter"`

---

## Task 10: monday API client + session-token bootstrap

**Files:**
- Create: `monday-app/src/monday-client.ts`

Wraps `monday-sdk-js`. All reads/writes use API version `2024-10` (writing `board_relation` `item_ids` works there; only *creating* that column type needed 2025-10). I/O verified live (Task 14), matching the repo's convention.

- [ ] **Step 1: Empirically confirm the session-token signing secret (blocking, one-time)** — in a monday Board View dev session, log `await monday.get("sessionToken")`, then locally verify its signature against the app's **Client Secret** and **Signing Secret** (Node repl using the same HS256 check as `worker/src/session.ts`). Whichever verifies is the value for `MONDAY_APP_SESSION_SECRET` (Task 3, Step 8). Record the winner in the spec.

- [ ] **Step 2: Implement** — `monday-app/src/monday-client.ts`:

```typescript
import mondaySdk from "monday-sdk-js";
import {
  DEALS_BOARD, SUBITEMS_BOARD, CONTACT_BOARD, COMPANY_BOARD,
  CONTACT_ID_COL, COMPANY_ID_COL,
} from "./board-config";

const monday = mondaySdk();
monday.setApiVersion("2024-10");

async function api<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res: any = await monday.api(query, { variables });
  if (res.errors) throw new Error(JSON.stringify(res.errors));
  return res.data as T;
}

export interface Ctx { userId: string; sessionToken: string }
/** Read the board-view context (current user) + a fresh session token for Worker calls. */
export async function getContext(): Promise<Ctx> {
  const ctx: any = await monday.get("context");
  const tok: any = await monday.get("sessionToken");
  return { userId: String(ctx?.data?.user?.id ?? ""), sessionToken: String(tok?.data ?? "") };
}

export interface BoardMeta {
  columns: { id: string; type: string; title: string }[];
  groups: { id: string; title: string }[];
}
export async function getBoardMeta(): Promise<BoardMeta> {
  const d = await api(`query ($b:[ID!]) { boards(ids:$b) {
    columns { id type title } groups { id title } } }`, { b: [DEALS_BOARD] });
  const board = d.boards[0];
  return { columns: board.columns, groups: board.groups };
}

export interface AccountUser { id: string; name: string; email: string }
export async function getUsers(): Promise<AccountUser[]> {
  const d = await api(`query { users(kind: non_guests, limit: 500) { id name email } }`);
  return (d.users ?? []).map((u: any) => ({ id: String(u.id), name: u.name, email: u.email }));
}

// Raw item shape the app reads (deals + their column values, incl. linked ids for relation columns).
export interface RawItem {
  id: string; name: string; group: { id: string };
  column_values: { id: string; text: string | null; value: string | null; linked_item_ids?: string[] }[];
}
export async function getDeals(): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let cursor: string | null = null;
  do {
    const d: any = await api(
      `query ($b:[ID!], $cursor:String) { boards(ids:$b) {
        items_page(limit:200, cursor:$cursor) {
          cursor
          items { id name group { id }
            column_values { id text ... on BoardRelationValue { linked_item_ids } } }
        } } }`, { b: [DEALS_BOARD], cursor });
    const page = d.boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export async function getSubitems(parentItemId: string): Promise<RawItem[]> {
  const d: any = await api(`query ($i:[ID!]) { items(ids:$i) {
    subitems { id name column_values { id text } } } }`, { i: [parentItemId] });
  return d.items[0]?.subitems ?? [];
}

export async function getUpdates(itemId: string): Promise<{ id: string; body: string; creator?: { name: string } }[]> {
  const d: any = await api(`query ($i:ID!) { items(ids:[$i]) {
    updates(limit:50) { id body creator { name } } } }`, { i: itemId });
  return d.items[0]?.updates ?? [];
}

// ---- writes (all honor monday's own permissions; the app never bypasses them) ----
export async function createDeal(groupId: string, name: string, columnValues: Record<string, unknown>): Promise<string> {
  const d: any = await api(`mutation ($b:ID!, $g:String!, $n:String!, $c:JSON!) {
    create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c) { id } }`,
    { b: DEALS_BOARD, g: groupId, n: name, c: JSON.stringify(columnValues) });
  return String(d.create_item.id);
}
export async function updateDealColumns(itemId: string, columnValues: Record<string, unknown>): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: DEALS_BOARD, i: itemId, c: JSON.stringify(columnValues) });
}
export async function renameDeal(itemId: string, name: string): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: DEALS_BOARD, i: itemId, c: JSON.stringify({ name }) });
}
export async function moveToGroup(itemId: string, groupId: string): Promise<void> {
  await api(`mutation ($i:ID!, $g:String!) { move_item_to_group(item_id:$i, group_id:$g) { id } }`,
    { i: itemId, g: groupId });
}
export async function createSubitem(parentItemId: string, name: string, columnValues: Record<string, unknown>): Promise<string> {
  const d: any = await api(`mutation ($p:ID!, $n:String!, $c:JSON!) {
    create_subitem(parent_item_id:$p, item_name:$n, column_values:$c) { id } }`,
    { p: parentItemId, n: name, c: JSON.stringify(columnValues) });
  return String(d.create_subitem.id);
}
export async function updateSubitemColumns(itemId: string, columnValues: Record<string, unknown>): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: SUBITEMS_BOARD, i: itemId, c: JSON.stringify(columnValues) });
}
export async function deleteItem(itemId: string): Promise<void> {
  await api(`mutation ($i:ID!) { delete_item(item_id:$i) { id } }`, { i: itemId });
}
export async function postUpdate(itemId: string, body: string): Promise<void> {
  await api(`mutation ($i:ID!, $b:String!) { create_update(item_id:$i, body:$b) { id } }`, { i: itemId, b: body });
}

/** Find a card by HubSpot id on a linked board, else create it (name only). Returns the monday item id.
 * Used for associations: the Worker fills the rest of the card on its next sync. */
async function findCardByHubspotId(boardId: string, idCol: string, hubspotId: string): Promise<string | null> {
  const d: any = await api(`query ($b:ID!, $col:String!, $val:String!) {
    items_page_by_column_values(board_id:$b, limit:1,
      columns: [{ column_id:$col, column_values:[$val] }]) { items { id } } }`,
    { b: boardId, col: idCol, val: hubspotId });
  const hit = d.items_page_by_column_values?.items?.[0];
  return hit ? String(hit.id) : null;
}
export async function findOrCreateContact(hubspotId: string, name: string): Promise<string> {
  return (await findCardByHubspotId(CONTACT_BOARD, CONTACT_ID_COL, hubspotId))
    ?? await createOnBoard(CONTACT_BOARD, CONTACT_ID_COL, hubspotId, name);
}
export async function findOrCreateCompany(hubspotId: string, name: string): Promise<string> {
  return (await findCardByHubspotId(COMPANY_BOARD, COMPANY_ID_COL, hubspotId))
    ?? await createOnBoard(COMPANY_BOARD, COMPANY_ID_COL, hubspotId, name);
}
async function createOnBoard(boardId: string, idCol: string, hubspotId: string, name: string): Promise<string> {
  // Re-query right before create to shrink the two-users-same-record race; the Worker dedups the rest.
  const existing = await findCardByHubspotId(boardId, idCol, hubspotId);
  if (existing) return existing;
  const d: any = await api(`mutation ($b:ID!, $n:String!, $c:JSON!) {
    create_item(board_id:$b, item_name:$n, column_values:$c) { id } }`,
    { b: boardId, n: name, c: JSON.stringify({ [idCol]: hubspotId }) });
  return String(d.create_item.id);
}
```

- [ ] **Step 3: Type-check** — `cd monday-app && npx tsc -b` → no errors.
- [ ] **Step 4: Commit** — `git add monday-app/src/monday-client.ts && git commit -m "feat(monday-app): monday.api client (context, board meta, deals, writes, find-or-create)"`

---

## Task 11: Worker client (session-token calls)

**Files:**
- Create: `monday-app/src/worker-client.ts`

- [ ] **Step 1: Implement** — `monday-app/src/worker-client.ts`:

```typescript
import { WORKER_BASE } from "./board-config";

async function call(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(WORKER_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`worker ${method} ${path}: ${res.status}`);
  return res.json();
}

export interface Hit { id: string; name: string; secondary: string }
export async function searchHubspot(token: string, type: "contacts" | "companies" | "products", q: string): Promise<Hit[]> {
  const res = await call(token, "GET", `/app/search?type=${type}&q=${encodeURIComponent(q)}&limit=10`);
  return res.results ?? [];
}
export async function updateHubspotLineItem(token: string, lineItemId: string, properties: Record<string, string>): Promise<void> {
  await call(token, "POST", "/app/line-item", { lineItemId, properties });
}
export async function deleteHubspotLineItem(token: string, lineItemId: string): Promise<void> {
  await call(token, "DELETE", "/app/line-item", { lineItemId });
}
export async function deleteHubspotAssociation(
  token: string, toObject: "contacts" | "companies", fromId: string, toId: string,
): Promise<void> {
  await call(token, "DELETE", "/app/association", { fromObject: "deals", fromId, toObject, toId });
}
```

- [ ] **Step 2: Type-check** — `cd monday-app && npx tsc -b` → no errors.
- [ ] **Step 3: Commit** — `git add monday-app/src/worker-client.ts && git commit -m "feat(monday-app): Worker client for HubSpot search + edit/remove"`

---

## Task 12: App state hook — load context, validate schema, load deals

**Files:**
- Create: `monday-app/src/useBoard.ts`

- [ ] **Step 1: Implement** — `monday-app/src/useBoard.ts` (single hook that gates the UI on schema validity):

```typescript
import { useEffect, useState } from "react";
import { getContext, getBoardMeta, getUsers, getDeals, type AccountUser, type BoardMeta, type RawItem } from "./monday-client";
import { validateBoardSchema } from "./lib/schema";
import { DEAL_COLS } from "./board-config";
import type { DealRow } from "./lib/filter";

function colText(item: RawItem, colId: string): string { return item.column_values.find(c => c.id === colId)?.text ?? ""; }
function linkedIds(item: RawItem, colId: string): string[] { return item.column_values.find(c => c.id === colId)?.linked_item_ids ?? []; }

function toRow(item: RawItem): DealRow {
  const people = item.column_values.find(c => c.id === DEAL_COLS.salesUsers.id);
  let salesUserIds: string[] = [];
  try { salesUserIds = (JSON.parse(people?.value ?? "{}").personsAndTeams ?? []).map((p: any) => String(p.id)); } catch { /* empty */ }
  return {
    id: item.id, name: item.name, stage: colText(item, DEAL_COLS.stage.id), salesUserIds,
    amount: colText(item, DEAL_COLS.amount.id), currency: colText(item, DEAL_COLS.currency.id),
    closeDate: colText(item, DEAL_COLS.closeDate.id),
    company: colText(item, DEAL_COLS.company.id), contact: colText(item, DEAL_COLS.contact.id),
  };
}

export interface BoardState {
  loading: boolean; error: string | null; schemaErrors: string[];
  userId: string; sessionToken: string; users: AccountUser[]; meta: BoardMeta | null; rows: DealRow[];
  reload: () => Promise<void>;
}

export function useBoard(): BoardState {
  const [s, setS] = useState<Omit<BoardState, "reload">>({
    loading: true, error: null, schemaErrors: [], userId: "", sessionToken: "", users: [], meta: null, rows: [],
  });

  async function load() {
    setS(p => ({ ...p, loading: true, error: null }));
    try {
      const ctx = await getContext();
      const meta = await getBoardMeta();
      const schema = validateBoardSchema(meta.columns, meta.groups);
      if (!schema.ok) { setS(p => ({ ...p, loading: false, schemaErrors: schema.errors, meta })); return; }
      const [users, items] = await Promise.all([getUsers(), getDeals()]);
      setS({
        loading: false, error: null, schemaErrors: [], userId: ctx.userId, sessionToken: ctx.sessionToken,
        users, meta, rows: items.map(toRow),
      });
    } catch (e) {
      setS(p => ({ ...p, loading: false, error: String(e).slice(0, 200) }));
    }
  }
  useEffect(() => { void load(); }, []);
  return { ...s, reload: load };
}

export { colText, linkedIds };
```

- [ ] **Step 2: Type-check** — `cd monday-app && npx tsc -b` → no errors.
- [ ] **Step 3: Commit** — `git add monday-app/src/useBoard.ts && git commit -m "feat(monday-app): board state hook with schema gate"`

---

## Task 13: App shell + BoardView table

**Files:**
- Modify: `monday-app/src/App.tsx`
- Create: `monday-app/src/views/BoardView.tsx`

- [ ] **Step 1: Rewrite `App.tsx`** — wrap in Vibe theme, one `/board` route, config-error + loading gates:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "@vibe/core";
import BoardView from "./views/BoardView";

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/board" element={<BoardView />} />
          <Route path="*" element={<Navigate to="/board" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Implement `BoardView.tsx`** — schema/loader gates, filters, Vibe table, Create button, row→edit:

```tsx
import { useMemo, useState } from "react";
import { Button, Dropdown, Search, Flex, Text, Loader, Table, TableHeader, TableHeaderCell,
  TableBody, TableRow, TableCell, Toast } from "@vibe/core";
import { useBoard } from "../useBoard";
import { filterDeals } from "../lib/filter";
import { stageOptions } from "../lib/stage";
import DealModal from "./DealModal";

export default function BoardView() {
  const board = useBoard();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<string | undefined>();
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<string | null | undefined>(undefined); // undefined=closed, null=new, id=edit
  const [toast, setToast] = useState<string | null>(null);

  const stages = useMemo(() => board.meta ? stageOptions(board.meta.groups) : [], [board.meta]);
  const rows = useMemo(
    () => filterDeals(board.rows, { q, stage, mine, myUserId: board.userId }),
    [board.rows, q, stage, mine, board.userId]);

  if (board.loading) return <Flex justify="center" style={{ padding: 40 }}><Loader size={40} /></Flex>;
  if (board.schemaErrors.length)
    return <div style={{ padding: 24 }}>
      <Text type="text1" weight="bold">Configuration error — the board schema does not match this app.</Text>
      <ul>{board.schemaErrors.map(e => <li key={e}><Text>{e}</Text></li>)}</ul>
      <Text>Fix the board (or update board-config) and reload. Writing is disabled until this passes.</Text>
    </div>;
  if (board.error) return <div style={{ padding: 24 }}><Text>Failed to load: {board.error}</Text></div>;

  const columns = [
    { id: "name", title: "Deal" }, { id: "stage", title: "Stage" },
    { id: "amount", title: "Amount" }, { id: "currency", title: "Cur" },
    { id: "closeDate", title: "Close" }, { id: "company", title: "Company" }, { id: "contact", title: "Contact" },
  ];

  return (
    <div style={{ padding: 16 }}>
      <Flex gap={12} align="center" wrap style={{ marginBottom: 12 }}>
        <Search placeholder="Search deals" value={q} onChange={setQ} size="small" />
        <Dropdown placeholder="All stages" clearable options={stages.map(s => ({ label: s, value: s }))}
          onClear={() => setStage(undefined)} onOptionSelect={(o: any) => setStage(o?.value)} size="small" />
        <Button kind={mine ? "primary" : "tertiary"} size="small" onClick={() => setMine(m => !m)}>My deals</Button>
        <div style={{ flex: 1 }} />
        <Button size="small" onClick={() => setEditing(null)}>+ Create Deal</Button>
      </Flex>

      <Table columns={columns as any} errorState={<div />} emptyState={<Text>No deals match.</Text>}>
        <TableHeader>{columns.map(c => <TableHeaderCell key={c.id} title={c.title} />)}</TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.id} onClick={() => setEditing(r.id)} style={{ cursor: "pointer" }}>
              <TableCell>{r.name}</TableCell><TableCell>{r.stage}</TableCell>
              <TableCell>{r.amount}</TableCell><TableCell>{r.currency}</TableCell>
              <TableCell>{r.closeDate}</TableCell><TableCell>{r.company}</TableCell><TableCell>{r.contact}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editing !== undefined && (
        <DealModal
          itemId={editing} board={board}
          onClose={() => setEditing(undefined)}
          onSaved={async (msg) => { setEditing(undefined); setToast(msg); await board.reload(); }}
        />
      )}
      <Toast open={!!toast} onClose={() => setToast(null)} type="positive" autoHideDuration={4000}>{toast}</Toast>
    </div>
  );
}
```

- [ ] **Step 3: Build** — `cd monday-app && npm run build`
Expected: TypeScript compiles and Vite builds (a `DealModal` stub is added next; if the build runs before Task 14, temporarily export an empty component). To keep this task self-contained, first add a stub `monday-app/src/views/DealModal.tsx`:

```tsx
import type { BoardState } from "../useBoard";
export default function DealModal(_: { itemId: string | null; board: BoardState; onClose: () => void; onSaved: (m: string) => void }) {
  return null;
}
```

Then `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/App.tsx monday-app/src/views/BoardView.tsx monday-app/src/views/DealModal.tsx
git commit -m "feat(monday-app): app shell + BoardView table with filters and create/edit entry"
```

---

## Task 14: DealModal — create/edit form (fields, associations, line items, updates)

**Files:**
- Modify: `monday-app/src/views/DealModal.tsx`
- Create: `monday-app/src/views/AssociationPicker.tsx`, `monday-app/src/views/LineItemsEditor.tsx`, `monday-app/src/views/UpdatesPanel.tsx`

Robustness requirements enforced here: Save disabled while processing (no double-submit); on create the parent item id is persisted in state and **never re-created** on retry — only the failed follow-up step (links / subitems) reruns; find-or-create re-queries by HubSpot id before creating.

- [ ] **Step 1: `AssociationPicker.tsx`** — type-ahead over `/app/search`, find-or-create the card, show chips:

```tsx
import { useState } from "react";
import { Search, Chips, Flex, Text } from "@vibe/core";
import { searchHubspot, deleteHubspotAssociation, type Hit } from "../worker-client";
import { findOrCreateContact, findOrCreateCompany } from "../monday-client";

export interface Assoc { hubspotId: string; itemId: string; label: string }
interface Props {
  kind: "contacts" | "companies"; token: string; dealHubspotId: string | null;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
}
export default function AssociationPicker({ kind, token, dealHubspotId, value, onChange }: Props) {
  const [q, setQ] = useState(""); const [hits, setHits] = useState<Hit[]>([]);

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) { setHits([]); return; }
    try { setHits(await searchHubspot(token, kind, text)); } catch { setHits([]); }
  }
  async function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    const itemId = kind === "contacts"
      ? await findOrCreateContact(hit.id, hit.name) : await findOrCreateCompany(hit.id, hit.name);
    onChange([...value, { hubspotId: hit.id, itemId, label: hit.name }]);
    setQ(""); setHits([]);
  }
  async function remove(a: Assoc) {
    // If the deal is already synced to HubSpot, propagate the unlink; otherwise just drop it locally.
    if (dealHubspotId) { try { await deleteHubspotAssociation(token, kind, dealHubspotId, a.hubspotId); } catch { /* surfaced on save */ } }
    onChange(value.filter(v => v.hubspotId !== a.hubspotId));
  }
  return (
    <Flex direction="column" gap={4} align="start">
      <Text weight="bold">{kind === "contacts" ? "Contacts" : "Companies"}</Text>
      <Flex gap={4} wrap>{value.map(a => <Chips key={a.hubspotId} label={a.label} onDelete={() => void remove(a)} />)}</Flex>
      <Search size="small" placeholder={`Search ${kind}`} value={q} onChange={search} />
      {hits.map(h => <div key={h.id} style={{ cursor: "pointer" }} onClick={() => void add(h)}>
        <Text>{h.name} · {h.secondary}</Text></div>)}
    </Flex>
  );
}
```

- [ ] **Step 2: `LineItemsEditor.tsx`** — subitem rows; product search; edit/remove propagate for synced rows:

```tsx
import { useState } from "react";
import { Button, Search, TextField, Flex, Text } from "@vibe/core";
import { searchHubspot, updateHubspotLineItem, deleteHubspotLineItem, type Hit } from "../worker-client";
import { lineItemToSubitemColumns } from "../lib/columns";
import { createSubitem, updateSubitemColumns, deleteItem } from "../monday-client";

export interface LineItem {
  subitemId?: string; lineItemId?: string; // present once synced by the Worker
  productId?: string; name: string; unitPrice: string; quantity: string; currency?: string; description?: string;
}
interface Props { token: string; parentItemId: string | null; value: LineItem[]; onChange: (n: LineItem[]) => void }

export default function LineItemsEditor({ token, parentItemId, value, onChange }: Props) {
  const [q, setQ] = useState(""); const [hits, setHits] = useState<Hit[]>([]);
  async function search(text: string) {
    setQ(text); if (text.trim().length < 2) { setHits([]); return; }
    try { setHits(await searchHubspot(token, "products", text)); } catch { setHits([]); }
  }
  function addFromProduct(h: Hit) {
    onChange([...value, { productId: h.id, name: h.name, unitPrice: h.secondary || "0", quantity: "1" }]);
    setQ(""); setHits([]);
  }
  function patch(i: number, p: Partial<LineItem>) { onChange(value.map((li, j) => j === i ? { ...li, ...p } : li)); }
  async function remove(i: number) {
    const li = value[i];
    if (li.subitemId) await deleteItem(li.subitemId);               // remove the monday subitem
    if (li.lineItemId) { try { await deleteHubspotLineItem(token, li.lineItemId); } catch { /* surfaced on save */ } }
    onChange(value.filter((_, j) => j !== i));
  }
  return (
    <Flex direction="column" gap={6} align="start">
      <Text weight="bold">Line items</Text>
      {value.map((li, i) => (
        <Flex key={li.subitemId ?? i} gap={6} align="center">
          <Text>{li.name}</Text>
          <TextField size="small" placeholder="Qty" value={li.quantity} onChange={(v) => patch(i, { quantity: v })} />
          <TextField size="small" placeholder="Unit price" value={li.unitPrice} onChange={(v) => patch(i, { unitPrice: v })} />
          <Button kind="tertiary" size="small" onClick={() => void remove(i)}>Remove</Button>
        </Flex>
      ))}
      <Search size="small" placeholder="Add product" value={q} onChange={search} />
      {hits.map(h => <div key={h.id} style={{ cursor: "pointer" }} onClick={() => addFromProduct(h)}>
        <Text>{h.name} · {h.secondary}</Text></div>)}
    </Flex>
  );
}

// Persist line items to monday + (for already-synced rows) HubSpot. Returns the updated list (with new
// subitem ids). New rows are created as subitems; the Worker mirrors them to HubSpot on its next sync.
export async function persistLineItems(token: string, parentItemId: string, items: LineItem[]): Promise<LineItem[]> {
  const out: LineItem[] = [];
  for (const li of items) {
    const cols = lineItemToSubitemColumns(li);
    if (!li.subitemId) {
      const subitemId = await createSubitem(parentItemId, li.name, cols);
      out.push({ ...li, subitemId });
    } else {
      await updateSubitemColumns(li.subitemId, cols);
      if (li.lineItemId) await updateHubspotLineItem(token, li.lineItemId, {
        price: li.unitPrice, quantity: li.quantity, ...(li.currency ? { hs_line_item_currency_code: li.currency } : {}),
      });
      out.push(li);
    }
  }
  return out;
}
```

- [ ] **Step 3: `UpdatesPanel.tsx`** — list + post updates (edit mode only):

```tsx
import { useEffect, useState } from "react";
import { Button, TextArea, Flex, Text } from "@vibe/core";
import { getUpdates, postUpdate } from "../monday-client";

export default function UpdatesPanel({ itemId }: { itemId: string }) {
  const [list, setList] = useState<{ id: string; body: string; creator?: { name: string } }[]>([]);
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  async function load() { setList(await getUpdates(itemId)); }
  useEffect(() => { void load(); }, [itemId]);
  async function post() {
    if (!text.trim()) return;
    setBusy(true);
    try { await postUpdate(itemId, text.trim()); setText(""); await load(); } finally { setBusy(false); }
  }
  return (
    <Flex direction="column" gap={6} align="start">
      <Text weight="bold">Updates</Text>
      <TextArea placeholder="Write an update…" value={text} onChange={(e: any) => setText(e.target.value)} />
      <Button size="small" loading={busy} disabled={busy} onClick={() => void post()}>Post update</Button>
      {list.map(u => <div key={u.id}><Text><b>{u.creator?.name ?? "User"}:</b> {u.body.replace(/<[^>]+>/g, "")}</Text></div>)}
    </Flex>
  );
}
```

- [ ] **Step 4: Rewrite `DealModal.tsx`** — the form that ties it together with the robust save sequence:

```tsx
import { useEffect, useState } from "react";
import { Modal, ModalContent, ModalFooterButtons, TextField, Dropdown, Flex, Text } from "@vibe/core";
import type { BoardState } from "../useBoard";
import { dealFormToColumnValues, boardRelationValue, type DealForm } from "../lib/columns";
import { groupIdForStage, stageOptions } from "../lib/stage";
import { DEAL_COLS } from "../board-config";
import {
  createDeal, updateDealColumns, renameDeal, moveToGroup, getSubitems, getDeals,
} from "../monday-client";
import { colText, linkedIds } from "../useBoard";
import AssociationPicker, { type Assoc } from "./AssociationPicker";
import LineItemsEditor, { persistLineItems, type LineItem } from "./LineItemsEditor";
import UpdatesPanel from "./UpdatesPanel";

interface Props { itemId: string | null; board: BoardState; onClose: () => void; onSaved: (msg: string) => void }

export default function DealModal({ itemId, board, onClose, onSaved }: Props) {
  const isEdit = itemId != null;
  const [name, setName] = useState("");
  const [form, setForm] = useState<DealForm>({ salesUserIds: [board.userId] });
  const [contacts, setContacts] = useState<Assoc[]>([]);
  const [companies, setCompanies] = useState<Assoc[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [dealHubspotId, setDealHubspotId] = useState<string | null>(null);
  const [createdItemId, setCreatedItemId] = useState<string | null>(itemId); // persist so retries never re-create the parent
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stages = board.meta ? stageOptions(board.meta.groups) : [];

  // Edit mode: hydrate from the existing card + its subitems.
  useEffect(() => {
    if (!isEdit || !board.meta) return;
    void (async () => {
      const items = await getDeals();
      const it = items.find(i => i.id === itemId);
      if (!it) return;
      setName(it.name);
      setDealHubspotId(colText(it, DEAL_COLS.hubspotDealId.id) || null);
      const stage = colText(it, DEAL_COLS.stage.id);
      setForm({
        amount: colText(it, DEAL_COLS.amount.id), currency: colText(it, DEAL_COLS.currency.id),
        closeDate: colText(it, DEAL_COLS.closeDate.id), stage,
        dealType: colText(it, DEAL_COLS.dealType.id), priority: colText(it, DEAL_COLS.priority.id),
      });
      const subs = await getSubitems(itemId!);
      setLineItems(subs.map(su => ({
        subitemId: su.id, name: su.name,
        lineItemId: su.column_values.find(c => c.id === "text_mm53ds6w")?.text || undefined,
        productId: su.column_values.find(c => c.id === "text_mm54hbvj")?.text || undefined,
        unitPrice: su.column_values.find(c => c.id === "numeric_mm53rsfd")?.text || "",
        quantity: su.column_values.find(c => c.id === "numeric_mm531345")?.text || "",
      })));
    })();
  }, [isEdit, itemId, board.meta]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      // 1) Parent item: create once (persisted) or update.
      let parentId = createdItemId;
      if (!parentId) {
        const groupId = groupIdForStage(form.stage ?? stages[0], board.meta!.groups) ?? board.meta!.groups[0].id;
        parentId = await createDeal(groupId, name || "New Deal", dealFormToColumnValues(form));
        setCreatedItemId(parentId); // <- from here on, retries reuse this id and never create a second deal
      } else if (isEdit) {
        await renameDeal(parentId, name);
        await updateDealColumns(parentId, dealFormToColumnValues(form));
        const gid = groupIdForStage(form.stage ?? "", board.meta!.groups);
        if (gid) await moveToGroup(parentId, gid);
      }
      // 2) Associations: link the found/created cards on the deal's relation columns.
      await updateDealColumns(parentId, {
        [DEAL_COLS.contact.id]: boardRelationValue(contacts.map(c => c.itemId)),
        [DEAL_COLS.company.id]: boardRelationValue(companies.map(c => c.itemId)),
      });
      // 3) Line items: create new subitems / update+mirror synced ones.
      const persisted = await persistLineItems(board.sessionToken, parentId, lineItems);
      setLineItems(persisted);
      onSaved(isEdit ? "Deal updated" : "Deal created — syncing to HubSpot…");
    } catch (e) {
      setErr(`Save failed at a step — press Save to retry (the deal is not duplicated). ${String(e).slice(0, 160)}`);
    } finally { setSaving(false); }
  }

  return (
    <Modal show title={isEdit ? "Edit Deal" : "Create Deal"} onClose={onClose} width="720px">
      <ModalContent>
        <Flex direction="column" gap={10} align="stretch">
          <TextField title="Deal name" value={name} onChange={setName} />
          <Flex gap={10} wrap>
            <TextField title="Amount" value={form.amount ?? ""} onChange={(v) => setForm(f => ({ ...f, amount: v }))} />
            <TextField title="Currency" value={form.currency ?? ""} onChange={(v) => setForm(f => ({ ...f, currency: v }))} />
            <TextField title="Close date (YYYY-MM-DD)" value={form.closeDate ?? ""} onChange={(v) => setForm(f => ({ ...f, closeDate: v }))} />
          </Flex>
          <Dropdown placeholder="Stage" value={form.stage ? { label: form.stage, value: form.stage } : undefined}
            options={stages.map(s => ({ label: s, value: s }))}
            onOptionSelect={(o: any) => setForm(f => ({ ...f, stage: o?.value }))} />
          <AssociationPicker kind="contacts" token={board.sessionToken} dealHubspotId={dealHubspotId}
            value={contacts} onChange={setContacts} />
          <AssociationPicker kind="companies" token={board.sessionToken} dealHubspotId={dealHubspotId}
            value={companies} onChange={setCompanies} />
          <LineItemsEditor token={board.sessionToken} parentItemId={createdItemId} value={lineItems} onChange={setLineItems} />
          {isEdit && itemId && <UpdatesPanel itemId={itemId} />}
          {err && <Text color="negative">{err}</Text>}
        </Flex>
      </ModalContent>
      <ModalFooterButtons primaryButtonText={saving ? "Saving…" : "Save"} secondaryButtonText="Cancel"
        onPrimaryButtonClick={() => { if (!saving) void save(); }} onSecondaryButtonClick={onClose} />
    </Modal>
  );
}
```

- [ ] **Step 5: Build** — `cd monday-app && npm run build`
Expected: compiles and builds. (Vibe prop names/imports may need small adjustments to the installed `@vibe/core` version — fix any type errors the build reports; the logic and data flow above are the contract.)

- [ ] **Step 6: Commit**

```bash
git add monday-app/src/views/DealModal.tsx monday-app/src/views/AssociationPicker.tsx monday-app/src/views/LineItemsEditor.tsx monday-app/src/views/UpdatesPanel.tsx
git commit -m "feat(monday-app): create/edit DealModal with associations, line items, updates"
```

---

## Task 15: monday app manifest + deployment notes

**Files:**
- Create: `monday-app/DEPLOY.md`

- [ ] **Step 1: Write `monday-app/DEPLOY.md`**

```markdown
# Deploy the Deal Cockpit Board View

## OAuth scopes (Developer Center > OAuth)
boards:read, boards:write, me:read, users:read, updates:read, updates:write

## Build + push (monday-hosted)
1. `cd monday-app && npm install && npm run build`
2. `npm i -g @mondaycom/apps-cli` (once)
3. `mapps init` — paste the app's API token (Developer Center > … > "Show API token")
4. `mapps code:push -d ./dist` — uploads the built bundle to monday hosting
   (ZIP upload still exists but is being deprecated; use `code:push`.)
5. In the app's **Board View** feature, set the hosting URL to the pushed build and add the view.

## Worker secrets (already covered in the plan, Task 3 Step 8)
- `MONDAY_APP_SESSION_SECRET` — the secret that verifies the sessionToken (confirmed empirically in Task 10 Step 1)
- `MONDAY_ACCOUNT_ID` — the DKM monday account id

## Add to a board
Open the Hubspot Deals board → **+ (Add view)** → the app's Board View → "Deal Cockpit".
```

- [ ] **Step 2: Commit** — `git add monday-app/DEPLOY.md && git commit -m "docs(monday-app): deploy + scopes notes"`

---

## Task 16: Live end-to-end verification

- [ ] **Step 1:** Deploy the Worker (Task 3 Step 8) with the two new secrets set. Confirm `/app/search` returns results with a valid session token and **403** without one (`curl` with a bogus `Authorization: Bearer x`).
- [ ] **Step 2:** `mapps code:push` the app; add the Board View to the Hubspot Deals board. Confirm the table lists deals and the schema gate passes (no config error).
- [ ] **Step 3:** **Create** a deal with a contact, a company, and one product line item; Save. Confirm: card appears in the right stage group; within ~30s the Worker stamps the HubSpot Deal ID, and the HubSpot deal shows the association + line item.
- [ ] **Step 4:** **Edit** the deal: change amount + stage (card moves group), change a line item's quantity (HubSpot line item updates), remove a company link (HubSpot association removed), remove a line item (HubSpot line item deleted), post an update (HubSpot note created). Verify each in HubSpot.
- [ ] **Step 5:** Toggle **My deals** and the stage filter; confirm the table filters correctly. Double-click Save rapidly on a create; confirm exactly one deal is created (no duplicate).
- [ ] **Step 6:** Full test suites green: `cd worker && npx vitest run` and `cd monday-app && npm run test`.

---

## Self-Review Notes

- **Spec coverage:** Board View table + filters (Task 9,13); create/edit modal (Task 14); associations find-or-create + remove-propagates (Task 14 Step 1, Task 11, Task 3); line items create/edit/remove-propagates (Task 14 Step 2, Task 2, Task 3); updates list+post (Task 14 Step 3); session-token verification on `/app/*` with signature/exp/account/user (Task 1,3); scopes boards:read/write+me:read+users:read+updates:read/write (Task 15); startup schema validation + string ids (Task 8,12,5); robustness disable-save/no-parent-recreate/retry-failed-step/re-query-before-create (Task 14 Step 4, Task 10 `createOnBoard`); rotate exposed X-App-Secret (Task 3 drops the APP_SECRET path); KPI cards deferred (not in plan, per spec). Empirical secret check (Task 10 Step 1).
- **Type consistency:** `DealRow` (filter.ts) produced by `toRow` (useBoard) and consumed by BoardView; `DealForm` shared by columns.ts + DealModal; `Assoc`/`LineItem` defined once and imported; `verifySessionToken` signature identical across session.ts, its test, and `authApp`; `parseLineItemBody`/`parseAssociationBody` signatures match their tests and index.ts callers; board/column ids centralized in board-config.ts.
- **Placeholder scan:** none — every code step carries full code; the only intentional stub (DealModal in Task 13) is explicitly replaced in Task 14.
- **Known follow-ups flagged inline (not placeholders):** `@vibe/core` prop/import names may need small version-specific fixes at build (Task 13/14); real monday column `type` strings confirmed at first live load (Task 8); the session-secret identity confirmed empirically (Task 10 Step 1).
```

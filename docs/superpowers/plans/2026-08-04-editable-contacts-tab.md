# Editable Contacts Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Contacts tab to the Deal Cockpit app that mirrors the Companies tab — a live HubSpot contact directory plus an editable drawer that reverse-syncs contact fields and manages the contact's company + deal associations (both directions).

**Architecture:** Mirror the shipped Companies feature. New worker `listContacts`/`GET /app/contacts` (copy of `listCompanies`/`/app/companies`) + `POST /app/sync-contact` (copy of `/app/sync-company`) + `FROM_OK += "contacts"`. New app `ContactsView` + `ContactDrawer` + `lib/contact-form.ts` + `lib/contacts.ts` + `CONTACT_COLS`, reusing the generic `syncMondayItem` reverse, `mergeAssoc`, `AssociationPicker`, `getItem`/`updateItemColumns`/`renameItem`.

**Tech Stack:** Cloudflare Worker (TS), monday GraphQL 2026-07, HubSpot CRM v3, React 18 + Vite + vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-editable-contacts-tab-design.md`

**Toolchain (MUST follow):** Worker: `./node_modules/.bin/tsc --noEmit` / `./node_modules/.bin/vitest run` (NEVER `npx tsc`). App: `npm run build` (tsc + vite) / `./node_modules/.bin/vitest run`; `noUnusedLocals` ON. Commit code from the repo root with the exact messages below; **NO `Co-Authored-By: Claude` trailer**. Don't commit `docs/`. Don't deploy/push until Task 7. Branch: `feat/deals-single-board`.

**Verified constants (do not re-derive):**
- `CONTACTS_MYLA` (`worker/src/config.ts`): board `5029639630`, `idCol="numeric_mm4xw7rk"`, name=`firstname`, assoc `{companies:CONTACT_REL_COMPANY}` `{deals:CONTACT_REL_DEAL}`. Column ids: lastname `text_mm4scke9`, email `text_mm4p2bvb`, jobtitle `text_mm4sznkw`, phone `phone_mm4s31p3`, sales_user `multiple_person_mm542gng`, hubspot_owner_id `multiple_person_mm4p8xe2`, hs_lead_status `status`, leadsource `dropdown_mm4sj3kw`, manufacturer__c `dropdown_mm4t8gjf`. Label dicts: `leadStatus`, `contactSource`, `contactVendor`.
- Worker `CONTACT_REL_COMPANY="board_relation_mm54dbxk"`, `CONTACT_REL_DEAL="board_relation_mm54zahf"` (currently module-private in config.ts).
- App `board-config.ts`: `CONTACT_BOARD="5029639630"`, `CONTACT_ID_COL="numeric_mm4xw7rk"`, `DEALS_BOARD="5029480547"`, `DEAL_COLS.hubspotDealId.id="numeric_mm4nz332"`, `hubspotRecordUrl`/`HS_OBJ` already include deals.
- `peopleValue`/`boardRelationValue` in `monday-app/src/lib/columns.ts`.
- **Phone is Task 8 (gated).** Tasks 1-7 make Phone **read-only** (shown, not editable). Do NOT add `reverse:true` to `phone` until Task 8.

---

## Task 1: Worker — contact directory (pure fns + `listContacts`) + config reverse flags

**Files:**
- Modify: `worker/src/config.ts` (reverse flags on owner/leadsource/vendor)
- Modify: `worker/src/hubspot.ts` (add `CONTACT_LIST_PROPS`, `ContactHit`, `contactSearchBody`, `mapContactResult`, `listContacts`)
- Create: `worker/test/contacts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/test/contacts.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { contactSearchBody, mapContactResult, listContacts } from "../src/hubspot";
import type { Env } from "../src/types";

describe("contactSearchBody", () => {
  it("empty query: createdate HAS_PROPERTY, createdate-DESC sort, default limit 25", () => {
    const b = contactSearchBody({}) as any;
    expect(b.sorts).toEqual([{ propertyName: "createdate", direction: "DESCENDING" }]);
    expect(b.limit).toBe(25);
    expect(b.filterGroups).toEqual([{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }]);
    expect(b.query).toBeUndefined();
    expect(b.properties).toContain("firstname");
    expect(b.properties).toContain("email");
  });
  it("owner + created + activity in ONE and'd group; query kept alongside", () => {
    const b = contactSearchBody({ q: " jo ", ownerId: "77", created: { gte: 100, lte: 200 }, activity: { gte: 300 } }) as any;
    expect(b.query).toBe("jo");
    expect(b.filterGroups[0].filters).toEqual([
      { propertyName: "hubspot_owner_id", operator: "EQ", value: "77" },
      { propertyName: "createdate", operator: "GTE", value: 100 },
      { propertyName: "createdate", operator: "LTE", value: 200 },
      { propertyName: "notes_last_updated", operator: "GTE", value: 300 },
    ]);
  });
  it("clamps limit to [1,50] and forwards after", () => {
    expect((contactSearchBody({ limit: 999 }) as any).limit).toBe(50);
    expect((contactSearchBody({ limit: 0 }) as any).limit).toBe(1);
    expect((contactSearchBody({ after: "c1" }) as any).after).toBe("c1");
  });
});

describe("mapContactResult", () => {
  const owners = { "77": { name: "Jane Rep", email: "jane@dkm.com" } };
  const labels = { leadStatus: { NEW: "New" }, contactSource: { WEB: "Web" }, contactVendor: { ACME: "Acme" } };
  it("joins name, resolves owner + enum labels, '' when missing", () => {
    expect(mapContactResult({
      firstname: "Jo", lastname: "Lee", email: "jo@x.com", phone: "123", jobtitle: "CTO",
      company: "Acme Inc", hs_lead_status: "NEW", leadsource: "WEB", createdate: "2026-07-01T00:00:00Z",
      hubspot_owner_id: "77", sales_user: "77",
    } as any, owners as any, labels as any)).toEqual({
      name: "Jo Lee", email: "jo@x.com", phone: "123", jobtitle: "CTO", company: "Acme Inc",
      leadStatus: "New", leadSource: "Web", createdate: "2026-07-01T00:00:00Z",
      ownerName: "Jane Rep", salesUser: "77",
    });
  });
  it("no name falls back to email", () =>
    expect(mapContactResult({ email: "a@b.co" } as any, owners as any, labels as any).name).toBe("a@b.co"));
});

describe("listContacts", () => {
  const env = { HUBSPOT_ACCESS_TOKEN: "t" } as Env;
  afterEach(() => vi.unstubAllGlobals());
  it("maps id + fields and returns the next cursor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: "5", properties: { firstname: "Jo", lastname: "Lee", email: "jo@x.com" } }],
      paging: { next: { after: "25" } },
    }), { status: 200 })));
    const out = await listContacts(env, { q: "jo" }, { "77": { name: "Jane", email: null } }, {});
    expect(out.after).toBe("25");
    expect(out.items[0]).toMatchObject({ hubspotId: "5", name: "Jo Lee", email: "jo@x.com" });
  });
  it("after=null when no next page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    expect(await listContacts(env, {}, {}, {})).toEqual({ items: [], after: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./node_modules/.bin/vitest run contacts`
Expected: FAIL — `contactSearchBody` / `mapContactResult` / `listContacts` not exported.

- [ ] **Step 3: Add the directory code to `worker/src/hubspot.ts`**

Immediately after the company directory block (after `listCompanies`, ~line 326), add:

```ts
// --- /app/contacts directory (live HubSpot contact list + search) ---
export const CONTACT_LIST_PROPS = [
  "firstname", "lastname", "email", "phone", "jobtitle", "company",
  "hs_lead_status", "leadsource", "createdate", "hubspot_owner_id", "sales_user", "notes_last_updated",
];

export interface ContactHit {
  hubspotId: string; name: string; email: string; phone: string; jobtitle: string; company: string;
  leadStatus: string; leadSource: string; createdate: string; ownerName: string; salesUser: string;
}

/** Build the HubSpot contact search body. Pure/testable. Same shape as companySearchBody. */
export function contactSearchBody(args: { q?: string; after?: string; limit?: number } & CompanyFilters): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: CONTACT_LIST_PROPS,
    limit,
  };
  const filters: Record<string, unknown>[] = [];
  if (args.ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: args.ownerId });
  if (args.created?.gte != null) filters.push({ propertyName: "createdate", operator: "GTE", value: args.created.gte });
  if (args.created?.lte != null) filters.push({ propertyName: "createdate", operator: "LTE", value: args.created.lte });
  if (args.activity?.gte != null) filters.push({ propertyName: "notes_last_updated", operator: "GTE", value: args.activity.gte });
  if (args.activity?.lte != null) filters.push({ propertyName: "notes_last_updated", operator: "LTE", value: args.activity.lte });
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  if (filters.length) body.filterGroups = [{ filters }];
  else if (!query) body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** Map one HubSpot contact result to a ContactHit (minus id). Pure/testable. */
export function mapContactResult(
  p: Record<string, any>,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Omit<ContactHit, "hubspotId"> {
  const lab = (dict: string, v: string) => (v ? (labels?.[dict]?.[v] ?? v) : "");
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? "");
  return {
    name, email: p.email ?? "", phone: p.phone ?? "", jobtitle: p.jobtitle ?? "", company: p.company ?? "",
    leadStatus: lab("leadStatus", p.hs_lead_status ?? ""),
    leadSource: lab("contactSource", p.leadsource ?? ""),
    createdate: p.createdate ?? "",
    ownerName: p.hubspot_owner_id ? (ownersById[p.hubspot_owner_id]?.name ?? "") : "",
    salesUser: p.sales_user ?? "",
  };
}

/** Live contact list/search for /app/contacts. Returns mapped hits + the next-page cursor (or null). */
export async function listContacts(
  env: Env,
  args: { q?: string; after?: string; limit?: number } & CompanyFilters,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Promise<{ items: ContactHit[]; after: string | null }> {
  const res = await hs(env, "POST", "/crm/v3/objects/contacts/search", contactSearchBody(args), 2);
  const items = (res.results ?? []).map((r: any) => ({
    hubspotId: String(r.id), ...mapContactResult(r.properties ?? {}, ownersById, labels),
  }));
  return { items, after: res.paging?.next?.after ?? null };
}
```

(`CompanyFilters` and `hs` are already in `hubspot.ts` scope.)

- [ ] **Step 4: Add reverse flags to `CONTACTS_MYLA` in `worker/src/config.ts`**

Add `reverse: true` to `hubspot_owner_id`, `leadsource`, `manufacturer__c` (NOT phone — Task 8):

```ts
    { hs: "hubspot_owner_id", col: "multiple_person_mm4p8xe2", type: "people", reverse: true },
```
```ts
    { hs: "hs_lead_status", col: "status", type: "status", labels: "leadStatus", reverse: true }, // edit here -> writes back to HubSpot
    { hs: "leadsource", col: "dropdown_mm4sj3kw", type: "dropdown", labels: "contactSource", reverse: true },
    { hs: "manufacturer__c", col: "dropdown_mm4t8gjf", type: "dropdown", labels: "contactVendor", reverse: true },
```

(Leave `{ hs: "phone", col: "phone_mm4s31p3", type: "phone" }` unchanged — no `reverse`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run contacts`
Expected: PASS.

- [ ] **Step 6: Full gate**

Run: `./node_modules/.bin/tsc --noEmit` (clean) and `./node_modules/.bin/vitest run` (all green — the config reverse flags don't change forward sync).

- [ ] **Step 7: Commit**

```bash
git add worker/src/config.ts worker/src/hubspot.ts worker/test/contacts.test.ts
git commit -m "feat(worker): contact directory (listContacts) + contact reverse flags (owner/leadsource/vendor)"
```

---

## Task 2: Worker — `/app/contacts` + `/app/sync-contact` + `FROM_OK` contacts

**Files:**
- Modify: `worker/src/app-routes.ts` (`FROM_OK += "contacts"`; `parseSyncContactBody`)
- Modify: `worker/src/index.ts` (`GET /app/contacts`, `POST /app/sync-contact`, import `listContacts`)
- Modify: `worker/test/app-routes.test.ts` (extend the association test)

- [ ] **Step 1: Extend the failing test in `worker/test/app-routes.test.ts`**

Add:

```ts
import { parseAssociationBody } from "../src/app-routes";
describe("parseAssociationBody contacts fromObject", () => {
  it("accepts contacts -> companies and contacts -> deals", () => {
    expect(parseAssociationBody({ fromObject: "contacts", fromId: "1", toObject: "companies", toId: "2" }).ok).toBe(true);
    expect(parseAssociationBody({ fromObject: "contacts", fromId: "1", toObject: "deals", toId: "2" }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./node_modules/.bin/vitest run app-routes`
Expected: FAIL — `fromObject: "contacts"` currently rejected (`FROM_OK` = deals|companies).

- [ ] **Step 3: Widen `FROM_OK` + add `parseSyncContactBody` in `worker/src/app-routes.ts`**

```ts
const FROM_OK = new Set(["deals", "companies", "contacts"]);
```

Add next to `parseSyncCompanyBody`:

```ts
export interface SyncContactReq { ok: boolean; itemId?: string; error?: string }
export function parseSyncContactBody(body: any): SyncContactReq {
  const itemId = String(body?.itemId ?? "");
  if (!/^\d+$/.test(itemId)) return { ok: false, error: "itemId required" };
  return { ok: true, itemId };
}
```

- [ ] **Step 4: Add the endpoints in `worker/src/index.ts`**

Import: add `listContacts` to the `./hubspot` import and `parseSyncContactBody` to the `./app-routes` import.

Right after the `GET /app/companies` block, add (mirror it exactly, swapping `listCompanies`→`listContacts` and the log tag):

```ts
      // GET /app/contacts?q=&after=&limit= — live contact directory (newest-created first), paginated.
      if (url.pathname === "/app/contacts" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const after = url.searchParams.get("after") || undefined;
        const limit = Number(url.searchParams.get("limit") ?? "25");
        const numP = (k: string) => { const s = url.searchParams.get(k); if (!s) return undefined; const v = Number(s); return Number.isFinite(v) ? v : undefined; };
        const ownerId = url.searchParams.get("ownerId") || undefined;
        const created = { gte: numP("createdGte"), lte: numP("createdLte") };
        const activity = { gte: numP("activityGte"), lte: numP("activityLte") };
        const H = { ...CORS, "Cache-Control": "no-store" };
        try {
          const ctx = await getCtxCached(env);
          const { items, after: next } = await listContacts(
            env, { q, after, limit: Number.isFinite(limit) ? limit : 25, ownerId, created, activity },
            ctx.ownersById, ctx.labels);
          return Response.json({ results: items, after: next }, { headers: H });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/contacts] error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], after: null, error: scope ? "scope" : "contacts-failed" }, { headers: H });
        }
      }
```

Right after the `POST /app/sync-company` block, add:

```ts
      // POST /app/sync-contact { itemId } — reverse-sync a contact's monday edits (fields + company/deal links)
      if (url.pathname === "/app/sync-contact" && req.method === "POST") {
        const s = parseSyncContactBody(await req.json().catch(() => ({})));
        if (!s.ok) return Response.json({ error: s.error }, { status: 400, headers: CORS });
        try {
          await syncMondayItem(env, CONTACTS_MYLA.boardId, s.itemId!, appWriteOpts(env), { left: 8 });
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/sync-contact] item=${s.itemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ error: "sync-failed" }, { status: 502, headers: CORS });
        }
      }
```

Ensure `CONTACTS_MYLA` is in the `./config` import (it is imported already for other uses; if not, add it).

- [ ] **Step 5: Run tests + gate**

Run: `./node_modules/.bin/vitest run app-routes` (PASS) then `./node_modules/.bin/tsc --noEmit` (clean) and `./node_modules/.bin/vitest run` (all green).

- [ ] **Step 6: Commit**

```bash
git add worker/src/app-routes.ts worker/src/index.ts worker/test/app-routes.test.ts
git commit -m "feat(worker): /app/contacts directory + /app/sync-contact + contacts fromObject"
```

---

## Task 3: App — `board-config` CONTACT_COLS + `lib/contact-form.ts` + `lib/contacts.ts`

**Files:**
- Modify: `monday-app/src/board-config.ts`
- Create: `monday-app/src/lib/contact-form.ts`
- Create: `monday-app/src/lib/contacts.ts`
- Create: `monday-app/src/lib/contact-form.test.ts`

- [ ] **Step 1: Add contact columns to `monday-app/src/board-config.ts`**

After the `COMPANY_COLS` block, add:

```ts
// Contact Follow Up board editable columns (mirrors worker CONTACTS_MYLA reverse fields). Item name = firstname.
export const CONTACT_REL_COMPANY = "board_relation_mm54dbxk"; // Contact -> Company card link
export const CONTACT_REL_DEAL = "board_relation_mm54zahf";    // Contact -> Deal card link
export const CONTACT_COLS = {
  lastname:   { id: "text_mm4scke9",           kind: "text" },
  email:      { id: "text_mm4p2bvb",           kind: "text" },
  jobtitle:   { id: "text_mm4sznkw",           kind: "text" },
  phone:      { id: "phone_mm4s31p3",          kind: "phone" },       // read-only until Task 8
  salesUsers: { id: "multiple_person_mm542gng", kind: "multiple-person" },
  owner:      { id: "multiple_person_mm4p8xe2", kind: "multiple-person" },
  leadStatus: { id: "status",                  kind: "status" },
  leadSource: { id: "dropdown_mm4sj3kw",       kind: "dropdown" },
  vendor:     { id: "dropdown_mm4t8gjf",       kind: "dropdown" },
} as const;
```

- [ ] **Step 2: Write the failing test** — `monday-app/src/lib/contact-form.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { contactFormToColumnValues } from "./contact-form";

describe("contactFormToColumnValues", () => {
  it("maps text/status/dropdown/people and omits empty", () => {
    expect(contactFormToColumnValues({
      lastname: "Lee", email: "jo@x.com", jobtitle: "CTO",
      salesUserId: "7", ownerId: "9", leadStatus: "New", leadSource: "Web", vendor: "Acme",
    })).toEqual({
      text_mm4scke9: "Lee", text_mm4p2bvb: "jo@x.com", text_mm4sznkw: "CTO",
      multiple_person_mm542gng: { personsAndTeams: [{ id: 7, kind: "person" }] },
      multiple_person_mm4p8xe2: { personsAndTeams: [{ id: 9, kind: "person" }] },
      status: { label: "New" },
      dropdown_mm4sj3kw: { labels: ["Web"] },
      dropdown_mm4t8gjf: { labels: ["Acme"] },
    });
  });
  it("empty form -> {} (no clear path)", () => expect(contactFormToColumnValues({})).toEqual({}));
  it("does not write phone (read-only until Task 8)", () =>
    expect(contactFormToColumnValues({ phone: "123" } as any)).toEqual({}));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `./node_modules/.bin/vitest run contact-form`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `monday-app/src/lib/contact-form.ts`**

```ts
import { CONTACT_COLS } from "../board-config";
import { peopleValue } from "./columns";

export interface ContactForm {
  firstname?: string; lastname?: string; email?: string; jobtitle?: string;
  salesUserId?: string; ownerId?: string; leadStatus?: string; leadSource?: string; vendor?: string;
  // phone is displayed read-only until Task 8; intentionally not written here.
}

/** Contact form -> monday column_values (JSON-encode before sending). Empty fields OMITTED (no clear path
 * in v1). Enums use labels (status -> {label}, dropdown -> {labels:[label]}), people -> personsAndTeams.
 * The item name (firstname) is set separately via renameItem. */
export function contactFormToColumnValues(f: ContactForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (f.lastname?.trim()) cv[CONTACT_COLS.lastname.id] = f.lastname;
  if (f.email?.trim()) cv[CONTACT_COLS.email.id] = f.email;
  if (f.jobtitle?.trim()) cv[CONTACT_COLS.jobtitle.id] = f.jobtitle;
  if (f.salesUserId) cv[CONTACT_COLS.salesUsers.id] = peopleValue([f.salesUserId]);
  if (f.ownerId) cv[CONTACT_COLS.owner.id] = peopleValue([f.ownerId]);
  if (f.leadStatus?.trim()) cv[CONTACT_COLS.leadStatus.id] = { label: f.leadStatus };
  if (f.leadSource?.trim()) cv[CONTACT_COLS.leadSource.id] = { labels: [f.leadSource] };
  if (f.vendor?.trim()) cv[CONTACT_COLS.vendor.id] = { labels: [f.vendor] };
  return cv;
}
```

- [ ] **Step 5: Create `monday-app/src/lib/contacts.ts`**

```ts
export interface ContactHit {
  hubspotId: string; name: string; email: string; phone: string; jobtitle: string; company: string;
  leadStatus: string; leadSource: string; createdate: string; ownerName: string; salesUser: string;
}

/** A value or an em dash when blank. */
export function orDash(v: string): string { return v?.trim() ? v : "—"; }

/** Short calendar date; blank/invalid -> "—". */
export function fmtContactDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
```

(`NewDealSeed` is imported from `lib/companies.ts` where the drawer needs it — do not redefine it.)

- [ ] **Step 6: Run tests + gate**

Run: `./node_modules/.bin/vitest run contact-form` (PASS), then `npm run build` (clean — `noUnusedLocals`).

- [ ] **Step 7: Commit**

```bash
git add monday-app/src/board-config.ts monday-app/src/lib/contact-form.ts monday-app/src/lib/contacts.ts monday-app/src/lib/contact-form.test.ts
git commit -m "feat(app): CONTACT_COLS + contactFormToColumnValues + contacts lib"
```

---

## Task 4: App — worker-client contacts helpers + monday-client findItemByColumn + AssociationPicker deals kind

**Files:**
- Modify: `monday-app/src/worker-client.ts` (`listContacts`, `syncContact`; widen `fromObject`)
- Modify: `monday-app/src/monday-client.ts` (`findItemByColumn`)
- Modify: `monday-app/src/views/AssociationPicker.tsx` (`"deals"` kind)

- [ ] **Step 1: Widen the association `fromObject` type + add contacts helpers in `worker-client.ts`**

Change both signatures so `fromObject` also allows `"contacts"`:

```ts
export async function addHubspotAssociation(token: string, fromObject: "deals" | "companies" | "contacts", fromId: string, toObject: "contacts" | "companies" | "deals", toId: string): Promise<void> {
```
```ts
export async function deleteHubspotAssociation(token: string, fromObject: "deals" | "companies" | "contacts", fromId: string, toObject: "contacts" | "companies" | "deals", toId: string): Promise<void> {
```

Add, next to `syncCompany`/`listCompanies` (mirror them, swapping the path):

```ts
export async function syncContact(token: string, itemId: string): Promise<boolean> {
  const r = await call(token, "POST", "/app/sync-contact", { itemId });
  return !!(r as any)?.ok;
}
```

Add `listContacts` by **copying the existing `listCompanies` function in `worker-client.ts` verbatim**, changing only three things: the name (`listCompanies`→`listContacts`), the endpoint path (`/app/companies`→`/app/contacts`), and the item/return type (`Company`/`CompanyHit`→`ContactHit`, imported from `./lib/contacts`). The args object (`{ q, after, limit, ownerId, created, activity }`), the query-string building, and the `{ items, after }` return are identical — do not change them. (If `listCompanies`' item type is a local `Company` interface, add the `ContactHit` import; the field set matches `lib/contacts.ts`'s `ContactHit`.)

- [ ] **Step 2: Add `findItemByColumn` to `monday-client.ts`**

Add near `getCardsByIds`:

```ts
/** Find the monday item id on a board whose column equals a value (e.g. a deal card by its HubSpot id).
 * Returns the first match's id, or null. Used to resolve a picked HubSpot deal to its board card, since
 * deals are never created by the app (unlike contacts/companies via ensureCard). */
export async function findItemByColumn(boardId: string, columnId: string, value: string): Promise<string | null> {
  const data = await api(`query ($b: ID!, $c: String!, $v: String!) {
    items_page_by_column_values(board_id: $b, columns: [{ column_id: $c, column_values: [$v] }], limit: 1) { items { id } }
  }`, { b: boardId, c: columnId, v: value });
  return data?.items_page_by_column_values?.items?.[0]?.id ?? null;
}
```

(Match the existing `api(...)` GraphQL helper used by other `monday-client` functions; if the helper is named differently, use that name.)

- [ ] **Step 3: Add the `"deals"` kind to `AssociationPicker.tsx`**

Widen the prop type and the title map:

```ts
  kind: "contacts" | "companies" | "deals"; token: string;
```

Replace the title line:

```ts
      <div className="dc-section-title">{kind === "contacts" ? "Contacts" : kind === "deals" ? "Deals" : "Companies"}</div>
```

(`searchHubspot(token, "deals", …)` and `hubspotRecordUrl("deals", …)` already work; the placeholder/empty strings interpolate `kind` and read fine as "deals".)

- [ ] **Step 4: Gate**

Run: `npm run build` (clean — check no other `AssociationPicker` caller breaks, and every `deleteHubspotAssociation`/`addHubspotAssociation` call site still typechecks with the widened union).

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/worker-client.ts monday-app/src/monday-client.ts monday-app/src/views/AssociationPicker.tsx
git commit -m "feat(app): worker-client contacts helpers + findItemByColumn + AssociationPicker deals kind"
```

---

## Task 5: App — editable `ContactDrawer.tsx`

**Files:**
- Create: `monday-app/src/views/ContactDrawer.tsx`

Mirror `CompanyDrawer.tsx` (fields form + `AssociationPicker` for companies + deals + `mergeAssoc` fresh-on-open). No new unit test (UI/I-O — verified live in Task 7).

- [ ] **Step 1: Create `monday-app/src/views/ContactDrawer.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import DrawerShell from "./DrawerShell";
import AssociationPicker from "./AssociationPicker";
import { Field, SelectStr, SelectOpt, type Opt } from "./FormFields";
import { CONTACT_COLS, CONTACT_REL_COMPANY, CONTACT_REL_DEAL, CONTACT_BOARD, COMPANY_ID_COL, DEALS_BOARD, DEAL_COLS, hubspotRecordUrl } from "../board-config";
import { getItem, updateItemColumns, renameItem, getCardsByIds, findItemByColumn, openLink, openItemCard, type AccountUser } from "../monday-client";
import {
  ensureCard, syncContact, getRecordAssociations, getContactSchema,
  addHubspotAssociation, deleteHubspotAssociation, type EnumProp,
} from "../worker-client";
import { contactFormToColumnValues, type ContactForm } from "../lib/contact-form";
import { boardRelationValue } from "../lib/columns";
import { mergeAssoc } from "../lib/assoc-merge";
import type { Assoc } from "../lib/assoc";
import { colText, linkedIds } from "../useBoard";
import { useConfirm } from "../confirm";
import type { ContactHit } from "../lib/contacts";

interface Props {
  contact: ContactHit; token: string; users: AccountUser[];
  onClose: () => void; onSaved?: () => void;
}
const enumOpts = (schema: Record<string, EnumProp>, key: string): string[] =>
  (schema[key]?.options ?? []).map(o => o.label);

export default function ContactDrawer({ contact, token, users, onClose, onSaved }: Props) {
  const confirm = useConfirm();
  const [itemId, setItemId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<ContactForm & { firstname?: string; phone?: string }>({});
  const [origFirstname, setOrigFirstname] = useState("");
  const [companies, setCompanies] = useState<Assoc[]>([]);
  const [origCompanies, setOrigCompanies] = useState<Assoc[]>([]);
  const [deals, setDeals] = useState<Assoc[]>([]);
  const [origDeals, setOrigDeals] = useState<Assoc[]>([]);
  const [schema, setSchema] = useState<Record<string, EnumProp>>({});
  const savingRef = useRef(false);
  const title = contact.name || contact.email || "Contact";
  const userOpts: Opt[] = users.map(u => ({ value: u.id, label: u.name || u.email || u.id }));
  const set = (p: Partial<typeof form>) => { setDirty(true); setForm(f => ({ ...f, ...p })); };

  useEffect(() => { getContactSchema(token).then(setSchema).catch(() => {}); }, [token]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const id = await ensureCard(token, "contacts", contact.hubspotId);
        const it = await getItem(id);
        if (!it || !alive) { if (alive) setErr("Couldn't load this contact. Close and reopen."); return; }
        const people = (col: string) => {
          try { return (JSON.parse(it.column_values.find(c => c.id === col)?.value ?? "{}").personsAndTeams ?? [])
            .filter((p: any) => p.kind === "person").map((p: any) => String(p.id)); } catch { return []; }
        };
        const f: ContactForm & { firstname?: string; phone?: string } = {
          firstname: it.name,
          lastname: colText(it as any, CONTACT_COLS.lastname.id),
          email: colText(it as any, CONTACT_COLS.email.id),
          jobtitle: colText(it as any, CONTACT_COLS.jobtitle.id),
          phone: colText(it as any, CONTACT_COLS.phone.id),                 // read-only display
          salesUserId: people(CONTACT_COLS.salesUsers.id)[0],
          ownerId: people(CONTACT_COLS.owner.id)[0],
          leadStatus: colText(it as any, CONTACT_COLS.leadStatus.id),
          leadSource: colText(it as any, CONTACT_COLS.leadSource.id),
          vendor: colText(it as any, CONTACT_COLS.vendor.id),
        };
        const compCards = await getCardsByIds(linkedIds(it as any, CONTACT_REL_COMPANY), COMPANY_ID_COL);
        const dealCards = await getCardsByIds(linkedIds(it as any, CONTACT_REL_DEAL), DEAL_COLS.hubspotDealId.id);
        const [hsCompanies, hsDeals] = await Promise.all([
          getRecordAssociations(token, "contacts", contact.hubspotId, "companies").catch(() => []),
          getRecordAssociations(token, "contacts", contact.hubspotId, "deals").catch(() => []),
        ]);
        const mCompanies = mergeAssoc(compCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name })),
          hsCompanies.map(c => ({ hubspotId: c.hubspotId, name: c.name })));
        const mDeals = mergeAssoc(dealCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name })),
          hsDeals.map(c => ({ hubspotId: c.hubspotId, name: c.name })));
        if (!alive) return;
        setItemId(id); setForm(f); setOrigFirstname(it.name);
        setCompanies(mCompanies); setOrigCompanies(mCompanies);
        setDeals(mDeals); setOrigDeals(mDeals); setLoaded(true);
      } catch (e) { if (alive) setErr("Couldn't load this contact. " + String(e).slice(0, 120)); }
    })();
    return () => { alive = false; };
  }, [contact.hubspotId, token]);

  async function guardedClose() {
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", message: "This contact has edits that haven't been saved.", confirmLabel: "Discard changes", cancelLabel: "Keep editing" }))) return;
    onClose();
  }

  // companies: ensureCard creates a card if missing. deals: findItemByColumn (deals aren't ensureCard-creatable);
  // a deal with no board card stays HubSpot-only (added directly below).
  async function resolveCompanies(list: Assoc[]): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      out.push({ ...a, itemId: await ensureCard(token, "companies", a.hubspotId!) });
    }
    return out;
  }
  async function resolveDeals(list: Assoc[]): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      const cardId = await findItemByColumn(DEALS_BOARD, DEAL_COLS.hubspotDealId.id, a.hubspotId!);
      out.push(cardId ? { ...a, itemId: cardId } : a);   // not found -> HubSpot-only
    }
    return out;
  }

  async function save() {
    if (savingRef.current || !itemId) return;
    savingRef.current = true; setSaving(true); setErr(null);
    try {
      const cv = contactFormToColumnValues(form);
      if (Object.keys(cv).length) await updateItemColumns(CONTACT_BOARD, itemId, cv);
      if (form.firstname && form.firstname !== origFirstname) await renameItem(CONTACT_BOARD, itemId, form.firstname);
      const rc = await resolveCompanies(companies); setCompanies(rc);
      const rd = await resolveDeals(deals); setDeals(rd);
      await updateItemColumns(CONTACT_BOARD, itemId, {
        [CONTACT_REL_COMPANY]: boardRelationValue(rc.filter(c => c.itemId).map(c => c.itemId!)),
        [CONTACT_REL_DEAL]: boardRelationValue(rd.filter(d => d.itemId).map(d => d.itemId!)),
      });
      // Unlink removed (reverseAssociations never deletes).
      for (const o of origCompanies)
        if (o.hubspotId && !rc.some(c => c.hubspotId === o.hubspotId))
          try { await deleteHubspotAssociation(token, "contacts", contact.hubspotId, "companies", o.hubspotId); } catch { /* best effort */ }
      for (const o of origDeals)
        if (o.hubspotId && !rd.some(d => d.hubspotId === o.hubspotId))
          try { await deleteHubspotAssociation(token, "contacts", contact.hubspotId, "deals", o.hubspotId); } catch { /* best effort */ }
      // Deals with no board card (rare) aren't in the relation column, so push their HubSpot link directly.
      for (const d of rd)
        if (!d.itemId && d.hubspotId)
          try { await addHubspotAssociation(token, "contacts", contact.hubspotId, "deals", d.hubspotId); } catch { /* best effort */ }
      setOrigCompanies(rc); setOrigDeals(rd);
      await syncContact(token, itemId);   // reverse fields + push relation links to HubSpot
      setDirty(false); onSaved?.(); onClose();
    } catch (e) {
      setErr("Save failed — press Save to retry. " + String(e).slice(0, 200));
    } finally { setSaving(false); savingRef.current = false; }
  }

  const footer = (
    <>
      <button className="dc-btn" onClick={guardedClose}>Cancel</button>
      <button className="dc-btn dc-btn-primary" disabled={saving || !loaded} onClick={() => { if (!saving) void save(); }}>
        {saving ? "Saving…" : "Save changes"}
      </button>
    </>
  );
  const headerRight = (
    <>
      <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("contacts", contact.hubspotId))}>↗ HubSpot</button>
      {itemId && <button className="dc-btn dc-btn-sm" onClick={() => openItemCard(itemId)}>↗ card</button>}
    </>
  );

  return (
    <DrawerShell title={loaded ? ((form.firstname || "") + " " + (form.lastname || "")).trim() || title : title} ariaLabel={`Edit contact ${title}`} onClose={guardedClose} headerRight={headerRight} footer={footer}>
      {!loaded && !err && <div className="dc-mut">Loading contact…</div>}
      {err && <div className="dc-err">{err}</div>}
      {loaded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="dc-section-title">Contact</div>
          <div className="dc-grid">
            <Field label="First name"><input className="dc-field-input" value={form.firstname ?? ""} onChange={e => set({ firstname: e.target.value })} /></Field>
            <Field label="Last name"><input className="dc-field-input" value={form.lastname ?? ""} onChange={e => set({ lastname: e.target.value })} /></Field>
            <Field label="Email"><input className="dc-field-input" value={form.email ?? ""} onChange={e => set({ email: e.target.value })} /></Field>
            <Field label="Job title"><input className="dc-field-input" value={form.jobtitle ?? ""} onChange={e => set({ jobtitle: e.target.value })} /></Field>
            <Field label="Phone (read-only)"><input className="dc-field-input" value={form.phone ?? ""} disabled /></Field>
            <Field label="Sales user"><SelectOpt options={userOpts} value={form.salesUserId} onChange={v => set({ salesUserId: v })} placeholder="No sales user" /></Field>
            <Field label="Owner"><SelectOpt options={userOpts} value={form.ownerId} onChange={v => set({ ownerId: v })} placeholder="No owner" /></Field>
            <Field label="Lead status"><SelectStr options={enumOpts(schema, "leadStatus")} value={form.leadStatus} onChange={v => set({ leadStatus: v })} placeholder="—" /></Field>
            <Field label="Lead source"><SelectStr options={enumOpts(schema, "leadSource")} value={form.leadSource} onChange={v => set({ leadSource: v })} placeholder="—" /></Field>
            <Field label="Vendor"><SelectStr options={enumOpts(schema, "vendor")} value={form.vendor} onChange={v => set({ vendor: v })} placeholder="—" /></Field>
          </div>

          {/* AssociationPicker renders its own "Companies"/"Deals" section title — no preceding heading. */}
          <AssociationPicker kind="companies" token={token} value={companies} onChange={next => { setDirty(true); setCompanies(next); }} />
          <AssociationPicker kind="deals" token={token} value={deals} onChange={next => { setDirty(true); setDeals(next); }} />
        </div>
      )}
    </DrawerShell>
  );
}
```

**Implementer notes:**
- `getContactSchema` already exists in `worker-client` (v3.4 Phase B — `DealDrawer` imports it); it fetches the contact enum options. **Verify the exact schema keys it returns** and align the `enumOpts(schema, …)` calls to them: the code above uses `"leadStatus"`/`"leadSource"`/`"vendor"`; if `getContactSchema` keys by the HubSpot prop names instead (`hs_lead_status`/`leadsource`/`manufacturer__c`), use those keys in the three `enumOpts(...)` calls. (Not a code gap — a one-line key check against the shipped helper.)
- `SelectStr`/`SelectOpt`/`Field`/`Opt` (`FormFields.tsx`) and `colText`/`linkedIds` (`useBoard.ts`) are the same imports `CompanyDrawer` uses — mirror them. `COMPANY_ID_COL`/`CONTACT_REL_*`/`CONTACT_COLS`/`DEAL_COLS`/`DEALS_BOARD`/`CONTACT_BOARD` are all in `board-config`.

- [ ] **Step 2: Gate**

Run: `npm run build` (clean — resolve every placeholder/import so `noUnusedLocals` and types pass).

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/views/ContactDrawer.tsx
git commit -m "feat(app): editable ContactDrawer (fields + company/deal associations, reverse-synced)"
```

---

## Task 6: App — `ContactsView.tsx` + nav tab + route

**Files:**
- Create: `monday-app/src/views/ContactsView.tsx`
- Modify: `monday-app/src/App.tsx`

- [ ] **Step 1: Create `monday-app/src/views/ContactsView.tsx`**

Mirror `CompaniesView.tsx` exactly, with these substitutions: `listCompanies`→`listContacts`, `Company`→`ContactHit`, `CompanyDrawer`→`ContactDrawer`, title "Companies"→"Contacts", search placeholder "Search companies by name or domain"→"Search contacts by name or email", and the table columns → **Contact / Email / Company / Lead status / Owner / Created** (6 columns, `colSpan={6}`). The row cells:

```tsx
                      <tr key={c.hubspotId} onClick={() => setOpen(c)}>
                        <td>
                          <div className="dc-deal">
                            <span className="dc-avatar" style={{ background: avatarFor(label) }}>{initials(label)}</span>
                            <span className="dc-deal-name" title={label}>{label}</span>
                          </div>
                        </td>
                        <td className={c.email ? "" : "dc-mut"}>{orDash(c.email)}</td>
                        <td className="dc-trunc">{orDash(c.company)}</td>
                        <td className={c.leadStatus ? "" : "dc-mut"}>{orDash(c.leadStatus)}</td>
                        <td className="dc-trunc">{orDash(c.ownerName || c.salesUser)}</td>
                        <td className="dc-mut" style={{ whiteSpace: "nowrap" }}>{fmtContactDate(c.createdate)}</td>
                      </tr>
```

`label = c.name || c.email || "Contact"`. Import `orDash`/`fmtContactDate`/`ContactHit` from `../lib/contacts`, `listContacts`/`getOwners` from `../worker-client`. Keep the identical filters (owner + Created + Last activity via `DateRangeFilter`), debounce, pagination, skeleton/empty/retry, and `getUsers`. **Drop** `CompaniesView`'s `onCreateDeal`/`useNavigate`/`NewDealSeed` (the contact drawer has no "+ Deal" button in v1) so no unused imports remain (`noUnusedLocals`). Render `<ContactDrawer contact={open} token={token} users={users} onClose={() => setOpen(null)} onSaved={() => void load(q)} />`.

- [ ] **Step 2: Add the tab + route in `monday-app/src/App.tsx`**

Add the import and, after the Companies `NavLink`/`Route`:

```tsx
import ContactsView from "./views/ContactsView";
```
```tsx
            <NavLink to="/contacts" className={({ isActive }) => "dc-topnav-tab" + (isActive ? " on" : "")}>Contacts</NavLink>
```
```tsx
            <Route path="/contacts" element={<ContactsView />} />
```

- [ ] **Step 3: Gate**

Run: `npm run build` (clean) and `./node_modules/.bin/vitest run` (app suite green).

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/views/ContactsView.tsx monday-app/src/App.tsx
git commit -m "feat(app): Contacts tab (ContactsView) + nav route"
```

---

## Task 7: Deploy + live verification (Phone still read-only)

**Files:** none (ops).

- [ ] **Step 1: Full gate** — worker `./node_modules/.bin/tsc --noEmit` && `./node_modules/.bin/vitest run`; app `npm run build` && `./node_modules/.bin/vitest run` — all green.
- [ ] **Step 2: Deploy worker** — `./node_modules/.bin/wrangler deploy`.
- [ ] **Step 3: Smoke** — `GET /app/contacts` and `POST /app/sync-contact` return 403 on no-auth, 204 on OPTIONS.
- [ ] **Step 4: App publish (user step)** — `mapps code:push --client-side -d ./dist -a 11691779 -i 16011075`.
- [ ] **Step 5: Live verification (a test contact):** open the Contacts tab → search/filter works; open a contact → edit Last name / Email / Job title / Sales user / Owner / Lead status / Lead source / Vendor → each reaches HubSpot; add/remove a company and a deal → monday relation column AND HubSpot both reflect; open a contact linked to several companies/deals → all show; save with no changes → nothing dropped. Phone shows read-only.

---

## Task 8 (GATED): Phone editing — `expectedText` phone-diff + form field + loop verification

Only start after Tasks 1-7 are green and deployed. This is the one field carrying reconcile risk (see spec). If Step 4's loop check fails, revert to read-only (Tasks 1-7 already ship a working read-only Phone).

**Files:**
- Modify: `worker/src/mapping.ts` (`expectedText` phone branch)
- Modify: `worker/src/config.ts` (`reverse:true` on phone)
- Modify: `monday-app/src/lib/contact-form.ts` (write the phone column)
- Modify: `monday-app/src/views/ContactDrawer.tsx` (make Phone an editable field)
- Modify: `worker/test/*` (expectedText phone test)

- [ ] **Step 1: Write the failing test** for the reconcile phone-diff — `worker/test/reconcile.test.ts` (or the file that tests `expectedText`; create a small `mapping.test.ts` if none):

```ts
import { describe, it, expect } from "vitest";
import { expectedText } from "../src/mapping";
const f = { hs: "phone", col: "phone_mm4s31p3", type: "phone" } as any;
const ctx = {} as any;
describe("expectedText phone (digits-normalized, diffable)", () => {
  it("normalizes to digits so monday's echoed text round-trips", () => {
    expect(expectedText(f, "+1 (234) 567-8900", ctx)).toBe("12345678900");
    expect(expectedText(f, "234-567-8900", ctx)).toBe("2345678900");
  });
  it("empty -> ''", () => expect(expectedText(f, "", ctx)).toBe(""));
});
```

- [ ] **Step 2: Run to verify it fails** — `./node_modules/.bin/vitest run` (the phone case returns `null` today).

- [ ] **Step 3: Change `expectedText` in `worker/src/mapping.ts`** — remove `phone` from the null-returning line and add a phone branch that returns digits:

```ts
  if (f.type === "people") return null;              // people: matched by id, not text
  if (value === null || value === undefined || value === "") return "";
  const v = String(value).trim();
  if (f.type === "phone") return v.replace(/[^\d]/g, "");   // digits-only so monday's formatted echo round-trips
  switch (f.type) {
    // …unchanged…
```

(Verify the reconcile's monday-side comparison also normalizes the monday phone column text to digits before comparing — read `reconcile.ts` around the `expectedText` call and, if it compares against `colText`, normalize both with the same `replace(/[^\d]/g,"")`. The comparison MUST be digits-vs-digits or it will loop.)

- [ ] **Step 4: LIVE loop check (before enabling the form field).** Deploy the worker; edit a test contact's phone **in monday** and confirm via `wrangler tail`: exactly one reverse write to HubSpot `phone`, and the subsequent forward tick does **not** bounce it back (no repeating reconcile on that column). If it loops, STOP — revert Steps 3, keep Phone read-only, and report.

- [ ] **Step 5: Enable phone in the form** — add `reverse:true` to `phone` in `config.ts`; in `contact-form.ts` write `if (f.phone?.trim()) cv[CONTACT_COLS.phone.id] = { phone: f.phone.replace(/[^\d+]/g,"") };` (matching `mapping.ts`'s `{phone:"…"}` shape); in `ContactDrawer.tsx` make the Phone `<input>` editable (`onChange={e => set({ phone: e.target.value })}`, drop `disabled`, relabel "Phone").

- [ ] **Step 6: Gate + deploy + live-verify** phone edit end-to-end (monday → HubSpot, no loop; no revert).

- [ ] **Step 7: Commit**

```bash
git add worker/src/mapping.ts worker/src/config.ts monday-app/src/lib/contact-form.ts monday-app/src/views/ContactDrawer.tsx worker/test/
git commit -m "feat(contacts): editable phone (reconcile phone-diff + form field)"
```

---

## Self-review checklist (run after all tasks)

- Directory: `contactSearchBody`/`mapContactResult`/`listContacts` mirror the company trio; `/app/contacts` mirrors `/app/companies` (no-store, scope error).
- Reverse: owner/leadsource/vendor carry `reverse:true`; `/app/sync-contact` → `syncMondayItem(CONTACTS_MYLA.boardId)`; `FROM_OK` includes contacts; `add/deleteHubspotAssociation` `fromObject` widened to include contacts (every call site typechecks).
- Drawer: companies resolve via `ensureCard`, deals via `findItemByColumn` (HubSpot-only fallback); both relation columns written; removed unlinked from HubSpot; `mergeAssoc` fresh-on-open for both; save omits empty (no blanking).
- Every referenced symbol exists: `listContacts`/`syncContact`/`getContactSchema` (worker-client), `findItemByColumn` (monday-client), `CONTACT_COLS`/`CONTACT_REL_COMPANY`/`CONTACT_REL_DEAL` (board-config), `contactFormToColumnValues`/`ContactForm` (contact-form), `ContactHit`/`orDash`/`fmtContactDate` (contacts), `AssociationPicker` deals kind.
- Phone is read-only through Task 7; only Task 8 makes it editable, behind a live loop check.
- No `Co-Authored-By: Claude` trailer; `docs/` not committed.
```

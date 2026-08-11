# Companies Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Companies tab to the Deal Cockpit app — browse/search the ~25k synced companies (newest-created first), open a company to see its details + linked contacts, deep-link to HubSpot / the monday card, and start a deal pre-linked to the company (or company + a contact).

**Architecture:** The Worker gains one read endpoint (`GET /app/companies`, live HubSpot search, newest-created-first, paginated) and an additive field extension to `/app/associations` (contacts get email + title). The React app gains a top tab strip, a `CompaniesView` list, a `CompanyDrawer` detail, and a create-deal seed that flows through `BoardView`'s existing deal form. The frontend never calls HubSpot directly; the Worker is the only HubSpot caller.

**Tech Stack:** Cloudflare Worker (TypeScript) + vitest; React 18 + TS + Vite + vitest; monday GraphQL 2026-07; HubSpot CRM v3/v4.

**Spec:** `docs/superpowers/specs/2026-07-31-companies-tab-design.md`

**Deviation from spec (noted):** `CompaniesView` implements its debounce + stale-response guard **inline** (a `setTimeout` + a monotonic `seq` ref) rather than reusing the `useDebouncedSearch` hook, because the directory needs **append-pagination** ("Load more" via an `after` cursor) that the replace-only hook does not provide. The observable behavior (debounced, stale-proof search) is identical.

**Toolchain notes (must follow):**
- Worker typecheck: run `./node_modules/.bin/tsc --noEmit` from `worker/` — **never** `npx tsc` (it resolves the wrong `tsc@2.0.4`).
- Worker tests: `./node_modules/.bin/vitest run` from `worker/`.
- App: `npm test` (vitest), `npm run build` (tsc --noEmit + vite build) from `monday-app/`.
- Commit code from the repo root. Do **not** commit anything under `docs/` (the user commits docs themselves).

---

## File structure

**Worker**
- `worker/src/hubspot.ts` — add `COMPANY_LIST_PROPS`, `companySearchBody()`, `mapCompanyResult()`, `listCompanies()`, and `mapAssocRecord()` (pure). Keep `searchObjects`/`mapSearchResult` untouched.
- `worker/src/index.ts` — add `GET /app/companies`; rewrite the `/app/associations` per-record mapping to use `mapAssocRecord` and request `jobtitle`.
- `worker/test/companies.test.ts` — unit tests for `companySearchBody`, `mapCompanyResult`, `mapAssocRecord`, `listCompanies`.

**App**
- `monday-app/src/worker-client.ts` — `Company`/`CompanyContact` types + `listCompanies()` + `getCompanyContacts()`.
- `monday-app/src/lib/companies.ts` (+ `.test.ts`) — pure helpers: `buildDealSeed`, `fmtNumber`, `orDash`, `fmtCompanyDate`, and the `NewDealSeed` type.
- `monday-app/src/views/DealDrawer.tsx` — optional `initialAssoc` prop (seed contacts/companies on create).
- `monday-app/src/views/BoardView.tsx` — consume `location.state.newDeal`, open the seeded create drawer, clear the state.
- `monday-app/src/views/CompanyDrawer.tsx` — the detail drawer (new).
- `monday-app/src/views/CompaniesView.tsx` — the list screen (new).
- `monday-app/src/App.tsx` — tab strip + `/companies` route.
- `monday-app/src/styles.css` — tab strip + detail/contact styles.

---

## Task 1: Worker pure helpers — `companySearchBody` + `mapCompanyResult`

**Files:**
- Modify: `worker/src/hubspot.ts` (add near `SEARCH_PROPS`/`mapSearchResult`, ~line 210)
- Test: `worker/test/companies.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `worker/test/companies.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { companySearchBody, mapCompanyResult } from "../src/hubspot";

describe("companySearchBody", () => {
  it("empty query: no query, createdate HAS_PROPERTY filter, createdate-DESC sort, default limit 25", () => {
    expect(companySearchBody({})).toEqual({
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      properties: [
        "name", "domain", "industry", "type", "partner_with", "city", "state",
        "numberofemployees", "annualrevenue", "linkedin_company_page", "description",
        "createdate", "hubspot_owner_id", "sales_user",
      ],
      limit: 25,
      filterGroups: [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }],
    });
  });
  it("with a query: sets query, no filterGroups", () => {
    const b = companySearchBody({ q: "  acme " });
    expect(b.query).toBe("acme");
    expect(b.filterGroups).toBeUndefined();
  });
  it("clamps limit to [1,50] and forwards after when present", () => {
    expect(companySearchBody({ limit: 999, after: "c123" }).limit).toBe(50);
    expect(companySearchBody({ limit: 0 }).limit).toBe(1);
    expect(companySearchBody({ after: "c123" }).after).toBe("c123");
    expect(companySearchBody({}).after).toBeUndefined();
  });
});

describe("mapCompanyResult", () => {
  const owners = { "77": { name: "Jane Rep", email: "jane@dkm.com" } };
  const labels = {
    industry: { COMPUTER_SOFTWARE: "Computer Software" },
    companyType: { PARTNER: "Partner" },
    partnerWith: { DKM: "DKM" },
    salesUser: { "77": "Jane Rep" },
  };
  it("resolves owner + enum labels, falls back to raw when unmapped, '' when missing", () => {
    expect(mapCompanyResult({
      name: "Acme", domain: "acme.com", industry: "COMPUTER_SOFTWARE", type: "UNKNOWN_CODE",
      partner_with: "DKM", numberofemployees: "50", annualrevenue: "1000000",
      linkedin_company_page: "https://li/acme", description: "desc", createdate: "2026-07-01T00:00:00Z",
      hubspot_owner_id: "77", sales_user: "77",
    } as any, owners as any, labels as any)).toEqual({
      name: "Acme", domain: "acme.com", industry: "Computer Software", type: "UNKNOWN_CODE",
      partnerWith: "DKM", city: "", state: "", employees: "50", revenue: "1000000",
      linkedin: "https://li/acme", description: "desc", createdate: "2026-07-01T00:00:00Z",
      ownerName: "Jane Rep", salesUser: "Jane Rep",
    });
  });
  it("unmapped owner id + empty enums -> ''", () => {
    expect(mapCompanyResult({ hubspot_owner_id: "999" } as any, owners as any, labels as any))
      .toMatchObject({ ownerName: "", salesUser: "", industry: "", type: "", partnerWith: "" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: FAIL — `companySearchBody`/`mapCompanyResult` are not exported.

- [ ] **Step 3: Implement the helpers**

In `worker/src/hubspot.ts`, immediately after the `mapSearchResult` function (around line 228), add:

```ts
// --- /app/companies directory (live HubSpot company list + search) ---
export const COMPANY_LIST_PROPS = [
  "name", "domain", "industry", "type", "partner_with", "city", "state",
  "numberofemployees", "annualrevenue", "linkedin_company_page", "description",
  "createdate", "hubspot_owner_id", "sales_user",
];

export interface CompanyHit {
  hubspotId: string; name: string; domain: string; industry: string; type: string;
  partnerWith: string; city: string; state: string; employees: string; revenue: string;
  linkedin: string; description: string; createdate: string; ownerName: string; salesUser: string;
}

/** Build the HubSpot company search body. Pure/testable. Newest-created first; a query does full-text
 * (name+domain); an empty query uses a createdate HAS_PROPERTY filter (every company has one) so the
 * search is always valid rather than relying on a fully-empty body. */
export function companySearchBody(args: { q?: string; after?: string; limit?: number }): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);   // ?? not || so limit:0 clamps to 1
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: COMPANY_LIST_PROPS,
    limit,
  };
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  else body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** Map one HubSpot company result's properties to a CompanyHit (minus id). Pure/testable. `labels` is
 * ctx.labels; the enum fields (industry/type/partner_with/sales_user) resolve to display labels, falling
 * back to the raw value if unmapped. */
export function mapCompanyResult(
  p: Record<string, any>,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Omit<CompanyHit, "hubspotId"> {
  const lab = (dict: string, v: string) => (v ? (labels?.[dict]?.[v] ?? v) : "");
  return {
    name: p.name ?? "", domain: p.domain ?? "",
    industry: lab("industry", p.industry ?? ""),
    type: lab("companyType", p.type ?? ""),
    partnerWith: lab("partnerWith", p.partner_with ?? ""),
    city: p.city ?? "", state: p.state ?? "",
    employees: p.numberofemployees ?? "", revenue: p.annualrevenue ?? "",
    linkedin: p.linkedin_company_page ?? "", description: p.description ?? "",
    createdate: p.createdate ?? "",
    ownerName: p.hubspot_owner_id ? (ownersById[p.hubspot_owner_id]?.name ?? "") : "",
    salesUser: lab("salesUser", p.sales_user ?? ""),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run (from `worker/`): `./node_modules/.bin/tsc --noEmit` → clean.

```bash
git add worker/src/hubspot.ts worker/test/companies.test.ts
git commit -m "feat(worker): companySearchBody + mapCompanyResult pure helpers for /app/companies"
```

---

## Task 2: Worker `listCompanies` + `GET /app/companies` route

**Files:**
- Modify: `worker/src/hubspot.ts` (add `listCompanies` after `mapCompanyResult`)
- Modify: `worker/src/index.ts` (add route after the `/app/search` block, ~line 99)
- Test: `worker/test/companies.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `worker/test/companies.test.ts`:

```ts
import { afterEach, vi } from "vitest";
import { listCompanies } from "../src/hubspot";
import type { Env } from "../src/types";

describe("listCompanies", () => {
  const env = { HUBSPOT_ACCESS_TOKEN: "t" } as Env;
  afterEach(() => vi.unstubAllGlobals());

  it("maps results (id + fields) and returns the next cursor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: "5", properties: { name: "Acme", domain: "acme.com", hubspot_owner_id: "77" } }],
      paging: { next: { after: "25" } },
    }), { status: 200 })));
    const out = await listCompanies(env, { q: "acme" }, { "77": { name: "Jane", email: null } }, {});
    expect(out.after).toBe("25");
    expect(out.items[0]).toMatchObject({ hubspotId: "5", name: "Acme", domain: "acme.com", ownerName: "Jane" });
  });

  it("returns after=null when there is no next page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const out = await listCompanies(env, {}, {}, {});
    expect(out).toEqual({ items: [], after: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: FAIL — `listCompanies` not exported.

- [ ] **Step 3: Implement `listCompanies`**

In `worker/src/hubspot.ts`, immediately after `mapCompanyResult`, add:

```ts
/** Live company list/search for /app/companies. Returns mapped hits + the next-page cursor (or null). */
export async function listCompanies(
  env: Env,
  args: { q?: string; after?: string; limit?: number },
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Promise<{ items: CompanyHit[]; after: string | null }> {
  const res = await hs(env, "POST", "/crm/v3/objects/companies/search", companySearchBody(args), 2);
  const items = (res.results ?? []).map((r: any) => ({
    hubspotId: String(r.id), ...mapCompanyResult(r.properties ?? {}, ownersById, labels),
  }));
  return { items, after: res.paging?.next?.after ?? null };
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: PASS (7 tests total).

- [ ] **Step 5: Add the `/app/companies` route**

In `worker/src/index.ts`, first ensure `listCompanies` is imported. Find the existing hubspot import line (it already imports `searchObjects`, `getAssociatedIds`, `getRecordsByIds`, etc.) and add `listCompanies` to it.

Then, immediately after the `/app/search` handler's closing `}` (the block that ends around line 99, right before the `// GET /app/associations` comment), insert:

```ts
      // GET /app/companies?q=&after=&limit= — live company directory (newest-created first), paginated.
      if (url.pathname === "/app/companies" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const after = url.searchParams.get("after") || undefined;
        const limit = Number(url.searchParams.get("limit") ?? "25");
        const H = { ...CORS, "Cache-Control": "no-store" };
        try {
          const ctx = await getCtxCached(env);
          const { items, after: next } = await listCompanies(
            env, { q, after, limit: Number.isFinite(limit) ? limit : 25 }, ctx.ownersById, ctx.labels);
          return Response.json({ results: items, after: next }, { headers: H });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/companies] error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], after: null, error: scope ? "scope" : "companies-failed" }, { headers: H });
        }
      }
```

- [ ] **Step 6: Typecheck + commit**

Run (from `worker/`): `./node_modules/.bin/tsc --noEmit` → clean. `./node_modules/.bin/vitest run` → all pass.

```bash
git add worker/src/hubspot.ts worker/src/index.ts worker/test/companies.test.ts
git commit -m "feat(worker): GET /app/companies live directory endpoint"
```

---

## Task 3: Worker `/app/associations` contacts → email + title

**Files:**
- Modify: `worker/src/hubspot.ts` (add `mapAssocRecord`)
- Modify: `worker/src/index.ts` (rewrite the `/app/associations` mapping + add `jobtitle` prop)
- Test: `worker/test/companies.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `worker/test/companies.test.ts`:

```ts
import { mapAssocRecord } from "../src/hubspot";

describe("mapAssocRecord", () => {
  it("company -> {hubspotId, name} (name||domain)", () => {
    expect(mapAssocRecord("companies", { id: "9", properties: { domain: "acme.com" } }))
      .toEqual({ hubspotId: "9", name: "acme.com" });
  });
  it("contact -> {hubspotId, name, email, title}", () => {
    expect(mapAssocRecord("contacts", { id: "3", properties: { firstname: "Jo", lastname: "Lee", email: "jo@x.com", jobtitle: "CTO" } }))
      .toEqual({ hubspotId: "3", name: "Jo Lee", email: "jo@x.com", title: "CTO" });
  });
  it("contact with no name falls back to email; missing title/email -> ''", () => {
    expect(mapAssocRecord("contacts", { id: "4", properties: { email: "a@b.co" } }))
      .toEqual({ hubspotId: "4", name: "a@b.co", email: "a@b.co", title: "" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: FAIL — `mapAssocRecord` not exported.

- [ ] **Step 3: Implement `mapAssocRecord`**

In `worker/src/hubspot.ts`, after `listCompanies`, add:

```ts
/** Map an associated record for /app/associations. companies -> {hubspotId,name}; contacts also carry
 * email + jobtitle. Pure/testable. */
export function mapAssocRecord(
  to: string, rec: { id: string; properties: Record<string, string | null> },
): { hubspotId: string; name: string; email?: string; title?: string } {
  const p = rec.properties;
  if (to === "companies") return { hubspotId: rec.id, name: (p.name || p.domain || "").trim() };
  if (to === "contacts") {
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? "");
    return { hubspotId: rec.id, name, email: p.email ?? "", title: p.jobtitle ?? "" };
  }
  return { hubspotId: rec.id, name: "" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: PASS (10 tests total).

- [ ] **Step 5: Wire `mapAssocRecord` into the route**

In `worker/src/index.ts`, in the `GET /app/associations` handler, add `jobtitle` to the fetched props and replace the inline `.map(...)` with `mapAssocRecord`. Change:

```ts
          const recs = ids.length ? await getRecordsByIds(env, to, ids, ["name", "domain", "firstname", "lastname", "email"]) : [];
          const results = recs.map(r => {
            const p = r.properties;
            const name = to === "companies" ? (p.name || p.domain || "").trim()
                       : to === "contacts" ? ([p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? ""))
                       : "";
            return { hubspotId: r.id, name };
          });
```

to:

```ts
          const recs = ids.length ? await getRecordsByIds(env, to, ids, ["name", "domain", "firstname", "lastname", "email", "jobtitle"]) : [];
          const results = recs.map(r => mapAssocRecord(to, r));
```

Add `mapAssocRecord` to the hubspot import in `index.ts`.

- [ ] **Step 6: Typecheck + full worker tests + commit**

Run (from `worker/`): `./node_modules/.bin/tsc --noEmit` → clean. `./node_modules/.bin/vitest run` → all pass (existing associations/app-route tests still green).

```bash
git add worker/src/hubspot.ts worker/src/index.ts worker/test/companies.test.ts
git commit -m "feat(worker): /app/associations contacts return email + title"
```

---

## Task 4: App worker-client — `Company`/`CompanyContact` + `listCompanies` + `getCompanyContacts`

**Files:**
- Modify: `monday-app/src/worker-client.ts`

- [ ] **Step 1: Add the types + client functions**

In `monday-app/src/worker-client.ts`, after the `SearchResult` interface (around line 20), add:

```ts
export interface Company {
  hubspotId: string; name: string; domain: string; industry: string; type: string;
  partnerWith: string; city: string; state: string; employees: string; revenue: string;
  linkedin: string; description: string; createdate: string; ownerName: string; salesUser: string;
}
export interface CompanyContact { hubspotId: string; name: string; email: string; title: string }

/** Live company directory (newest-created first); `after` pages, `q` searches name+domain. Fails soft:
 * a Worker error comes back as { error } (HTTP 200), surfaced to the caller. */
export async function listCompanies(token: string, args: { q?: string; after?: string; limit?: number }):
    Promise<{ items: Company[]; after: string | null; error?: string }> {
  const p = new URLSearchParams();
  if (args.q?.trim()) p.set("q", args.q.trim());
  if (args.after) p.set("after", args.after);
  p.set("limit", String(args.limit ?? 25));
  const res = await call(token, "GET", `/app/companies?${p.toString()}`);
  return { items: res.results ?? [], after: res.after ?? null, error: res.error };
}

/** A company's linked HubSpot contacts (name/email/title), for the CompanyDrawer. */
export async function getCompanyContacts(token: string, companyHubspotId: string): Promise<CompanyContact[]> {
  const res = await call(token, "GET", `/app/associations?type=companies&id=${encodeURIComponent(companyHubspotId)}&to=contacts`);
  return res?.results ?? [];
}
```

- [ ] **Step 2: Typecheck + commit**

Run (from `monday-app/`): `npm run build` → passes (tsc + vite build).

```bash
git add monday-app/src/worker-client.ts
git commit -m "feat(app): worker-client listCompanies + getCompanyContacts"
```

---

## Task 5: App pure helpers — `lib/companies.ts`

**Files:**
- Create: `monday-app/src/lib/companies.ts`
- Test: `monday-app/src/lib/companies.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `monday-app/src/lib/companies.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildDealSeed, fmtNumber, orDash, fmtCompanyDate } from "./companies";

describe("buildDealSeed", () => {
  it("company only -> one company assoc, no contacts", () => {
    expect(buildDealSeed({ company: { hubspotId: "5", name: "Acme" } }))
      .toEqual({ companies: [{ label: "Acme", hubspotId: "5" }] });
  });
  it("company + contact -> both staged", () => {
    expect(buildDealSeed({ company: { hubspotId: "5", name: "Acme" }, contact: { hubspotId: "3", name: "Jo Lee" } }))
      .toEqual({ companies: [{ label: "Acme", hubspotId: "5" }], contacts: [{ label: "Jo Lee", hubspotId: "3" }] });
  });
});

describe("fmtNumber", () => {
  it("formats a numeric string with grouping", () => expect(fmtNumber("1000000")).toBe("1,000,000"));
  it("empty -> em dash", () => expect(fmtNumber("")).toBe("—"));
  it("non-numeric -> raw", () => expect(fmtNumber("N/A")).toBe("N/A"));
});

describe("orDash", () => {
  it("returns value when present", () => expect(orDash("x")).toBe("x"));
  it("blank -> em dash", () => { expect(orDash("")).toBe("—"); expect(orDash("  ")).toBe("—"); });
});

describe("fmtCompanyDate", () => {
  it("formats an ISO date", () => expect(fmtCompanyDate("2026-07-01T00:00:00Z")).toMatch(/2026/));
  it("empty/invalid -> em dash", () => { expect(fmtCompanyDate("")).toBe("—"); expect(fmtCompanyDate("nope")).toBe("—"); });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `monday-app/`): `npm test -- companies`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/companies.ts`**

Create `monday-app/src/lib/companies.ts`:

```ts
import type { Assoc } from "./assoc";

/** Seed carried from the Companies tab to open a pre-linked new deal (matches CompanyDrawer's onCreateDeal). */
export interface NewDealSeed {
  company: { hubspotId: string; name: string };
  contact?: { hubspotId: string; name: string };
}

/** NewDealSeed -> DealDrawer `initialAssoc`. Each seed is a plain Assoc ({label, hubspotId}); DealDrawer's
 * resolveAssocs calls ensureCard on save — identical to picking the record in the AssociationPicker. */
export function buildDealSeed(seed: NewDealSeed): { contacts?: Assoc[]; companies?: Assoc[] } {
  const out: { contacts?: Assoc[]; companies?: Assoc[] } = {
    companies: [{ label: seed.company.name, hubspotId: seed.company.hubspotId }],
  };
  if (seed.contact) out.contacts = [{ label: seed.contact.name, hubspotId: seed.contact.hubspotId }];
  return out;
}

/** Group-format a numeric string; blank -> "—"; non-numeric -> the raw string. */
export function fmtNumber(v: string): string {
  if (!v?.trim()) return "—";
  const n = Number(v);
  return isFinite(n) ? n.toLocaleString() : v;
}

/** A value or an em dash when blank. */
export function orDash(v: string): string { return v?.trim() ? v : "—"; }

/** Short calendar date; blank/invalid -> "—". */
export function fmtCompanyDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `monday-app/`): `npm test -- companies`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/companies.ts monday-app/src/lib/companies.test.ts
git commit -m "feat(app): companies pure helpers (seed builder + formatters)"
```

---

## Task 6: DealDrawer `initialAssoc` prop + BoardView seed consumption

**Files:**
- Modify: `monday-app/src/views/DealDrawer.tsx`
- Modify: `monday-app/src/views/BoardView.tsx`

- [ ] **Step 1: Add the `initialAssoc` prop to DealDrawer**

In `monday-app/src/views/DealDrawer.tsx`, change the `Props` interface (line 22) to add the optional prop:

```ts
interface Props { itemId: string | null; board: BoardState; onClose: () => void; onSaved: (info: SavedInfo) => void; onDirtyChange?: (dirty: boolean) => void; initialAssoc?: { contacts?: Assoc[]; companies?: Assoc[] } }
```

Update the component signature (line 27):

```ts
export default function DealDrawer({ itemId, board, onClose, onSaved, onDirtyChange, initialAssoc }: Props) {
```

Change the `contacts` / `companies` state initializers (lines 43-44) so a create drawer starts pre-seeded:

```ts
  const [contacts, setContacts] = useState<Assoc[]>(() => (!isEdit && initialAssoc?.contacts) ? initialAssoc.contacts : []);
  const [companies, setCompanies] = useState<Assoc[]>(() => (!isEdit && initialAssoc?.companies) ? initialAssoc.companies : []);
```

Change the `dirty` state initializer (line 62) so a seeded new deal is guarded against accidental discard:

```ts
  const [dirty, setDirty] = useState<boolean>(() => !isEdit && !!(initialAssoc?.contacts?.length || initialAssoc?.companies?.length));
```

(No other DealDrawer changes: `resolveAssocs` already turns `{label,hubspotId}` seeds into cards via `ensureCard` on Save.)

- [ ] **Step 2: Wire the seed through BoardView**

In `monday-app/src/views/BoardView.tsx`:

Add imports at the top:

```ts
import { useLocation, useNavigate } from "react-router-dom";
import { buildDealSeed, type NewDealSeed } from "../lib/companies";
import type { Assoc } from "../lib/assoc";
```

Inside `BoardView()`, after the existing `const [view, setView] = useState<"table" | "board">("table");` line, add:

```ts
  const location = useLocation();
  const navigate = useNavigate();
  const [dealSeed, setDealSeed] = useState<{ contacts?: Assoc[]; companies?: Assoc[] } | undefined>(undefined);

  // A "Create deal from company/contact" click on the Companies tab navigates here with a seed. Open a
  // pre-linked create drawer, then clear the router state so back/refresh doesn't reopen it.
  useEffect(() => {
    const nd = (location.state as { newDeal?: NewDealSeed } | null)?.newDeal;
    if (!nd) return;
    setDealSeed(buildDealSeed(nd));
    setCreating(null);
    setEditing(null);
    navigate(".", { replace: true, state: {} });
  }, [location.state]);
```

In `attemptOpen`, clear any stale seed so the normal "New Deal" button never inherits one. Change the body of `attemptOpen` to add `setDealSeed(undefined);`:

```ts
  async function attemptOpen(id: string | null) {
    if (!(await mayLeaveOpenDrawer())) return;
    drawerDirty.current = false;
    recordDirty.current = false;
    setDealSeed(undefined);
    setCreating(null);
    setEditing(id);
  }
```

Update the `DealDrawer` render (line ~283) to pass the seed on create and clear it on close/save:

```tsx
      {editing !== undefined && (
        <DealDrawer key={editing ?? "new"} itemId={editing} board={board}
          initialAssoc={editing === null ? dealSeed : undefined}
          onDirtyChange={d => { drawerDirty.current = d; }}
          onClose={() => { setEditing(undefined); setDealSeed(undefined); }}
          onSaved={(info) => {
            setEditing(undefined);
            setDealSeed(undefined);
            setToast({ text: "Saved to monday", type: "info" });
            void board.finishSave(info);
          }} />
      )}
```

- [ ] **Step 3: Typecheck + build + commit**

Run (from `monday-app/`): `npm run build` → passes.

```bash
git add monday-app/src/views/DealDrawer.tsx monday-app/src/views/BoardView.tsx
git commit -m "feat(app): seed a pre-linked new deal from a company/contact"
```

---

## Task 7: `CompanyDrawer` detail view

**Files:**
- Create: `monday-app/src/views/CompanyDrawer.tsx`

- [ ] **Step 1: Create the component**

Create `monday-app/src/views/CompanyDrawer.tsx`:

```tsx
import { useEffect, useState } from "react";
import DrawerShell from "./DrawerShell";
import { getCompanyContacts, ensureCard, type Company, type CompanyContact } from "../worker-client";
import { openLink, openItemCard } from "../monday-client";
import { hubspotRecordUrl } from "../board-config";
import { fmtNumber, orDash, fmtCompanyDate, type NewDealSeed } from "../lib/companies";

interface Props {
  company: Company;
  token: string;
  onClose: () => void;
  onCreateDeal: (seed: NewDealSeed) => void;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="dc-detail">
      <div className="dc-detail-label">{label}</div>
      <div className="dc-detail-value">{value}</div>
    </div>
  );
}

export default function CompanyDrawer({ company, token, onClose, onCreateDeal }: Props) {
  const [contacts, setContacts] = useState<CompanyContact[] | null>(null);
  const [cErr, setCErr] = useState(false);
  const [opening, setOpening] = useState(false);
  const title = company.name || company.domain || "Company";

  async function loadContacts() {
    setCErr(false); setContacts(null);
    try { setContacts(await getCompanyContacts(token, company.hubspotId)); }
    catch { setCErr(true); }
  }
  useEffect(() => { void loadContacts(); }, [company.hubspotId]);

  async function openMondayCard() {
    setOpening(true);
    try { openItemCard(await ensureCard(token, "companies", company.hubspotId)); }
    catch { /* best effort */ }
    finally { setOpening(false); }
  }

  const count = contacts ? (contacts.length === 100 ? "100+" : String(contacts.length)) : "";
  const location = [company.city, company.state].filter(Boolean).join(", ");

  return (
    <DrawerShell title={title} ariaLabel={`Company ${title}`} onClose={onClose}>
      <div className="dc-drawer-actions">
        <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("companies", company.hubspotId))}>↗ HubSpot</button>
        <button className="dc-btn dc-btn-sm" disabled={opening} onClick={() => void openMondayCard()}>{opening ? "Opening…" : "↗ monday card"}</button>
        <button className="dc-btn dc-btn-primary dc-btn-sm" onClick={() => onCreateDeal({ company: { hubspotId: company.hubspotId, name: title } })}>＋ Create deal</button>
      </div>

      <div className="dc-section-title">Company</div>
      <div className="dc-detail-grid">
        <Detail label="Domain" value={orDash(company.domain)} />
        <Detail label="Industry" value={orDash(company.industry)} />
        <Detail label="Type" value={orDash(company.type)} />
        <Detail label="Partner with" value={orDash(company.partnerWith)} />
        <Detail label="Location" value={orDash(location)} />
        <Detail label="Employees" value={fmtNumber(company.employees)} />
        <Detail label="Annual revenue" value={fmtNumber(company.revenue)} />
        <Detail label="Owner" value={orDash(company.ownerName)} />
        <Detail label="Sales user" value={orDash(company.salesUser)} />
        <Detail label="Created" value={fmtCompanyDate(company.createdate)} />
        <Detail label="LinkedIn" value={company.linkedin
          ? <a href={company.linkedin} onClick={e => { e.preventDefault(); openLink(company.linkedin); }}>{company.linkedin}</a>
          : "—"} />
      </div>
      {company.description && (
        <>
          <div className="dc-section-title">Description</div>
          <p className="dc-detail-desc">{company.description}</p>
        </>
      )}

      <div className="dc-section-title">Contacts{count ? ` (${count})` : ""}</div>
      {contacts === null && !cErr && <div className="dc-mut">Loading contacts…</div>}
      {cErr && (
        <div className="dc-empty">Couldn't load contacts. <button className="dc-btn dc-btn-sm" onClick={() => void loadContacts()}>Retry</button></div>
      )}
      {contacts && contacts.length === 0 && <div className="dc-mut">No linked contacts.</div>}
      {contacts && contacts.length > 0 && (
        <div className="dc-contact-list">
          {contacts.map(c => (
            <div key={c.hubspotId} className="dc-contact-row">
              <div className="dc-contact-info">
                <span className="dc-contact-name">{c.name}</span>
                {(c.email || c.title) && <span className="dc-mut">{[c.email, c.title].filter(Boolean).join(" · ")}</span>}
              </div>
              <div className="dc-contact-actions">
                <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("contacts", c.hubspotId))}>↗ HubSpot</button>
                <button className="dc-btn dc-btn-sm" onClick={() => onCreateDeal({ company: { hubspotId: company.hubspotId, name: title }, contact: { hubspotId: c.hubspotId, name: c.name } })}>＋ Deal</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DrawerShell>
  );
}
```

- [ ] **Step 2: Typecheck + build + commit**

Run (from `monday-app/`): `npm run build` → passes (CompanyDrawer is imported by CompaniesView in Task 8; until then it's an unused module, which builds fine).

```bash
git add monday-app/src/views/CompanyDrawer.tsx
git commit -m "feat(app): CompanyDrawer detail view (fields + contacts + actions)"
```

---

## Task 8: `CompaniesView` list screen

**Files:**
- Create: `monday-app/src/views/CompaniesView.tsx`

- [ ] **Step 1: Create the component**

Create `monday-app/src/views/CompaniesView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getContext } from "../monday-client";
import { listCompanies, type Company } from "../worker-client";
import { orDash, fmtCompanyDate, type NewDealSeed } from "../lib/companies";
import CompanyDrawer from "./CompanyDrawer";

const AVATAR = ["#4b6ef5", "#7b5cff", "#e8952a", "#10b26b", "#2b90d9", "#e14a63", "#0ea5a5", "#d9488c"];
function avatarFor(name: string) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const c1 = AVATAR[Math.abs(h) % AVATAR.length];
  const c2 = AVATAR[Math.abs(h >> 3) % AVATAR.length];
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}
function initials(name: string): string {
  const t = name.trim(); if (!t) return "?";
  if (/[一-鿿]/.test(t)) return t.slice(0, 1);
  const p = t.split(/\s+/);
  return (p[0][0] + (p[1]?.[0] ?? "")).toUpperCase();
}

export default function CompaniesView() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Company[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Company | null>(null);
  const seq = useRef(0);

  useEffect(() => { getContext().then(c => setToken(c.sessionToken)).catch(() => setError(true)); }, []);

  // `cursor` present -> append (Load more); absent -> replace (new query / initial). A monotonic seq id
  // drops any stale response so a fast typer never sees out-of-order results.
  async function load(query: string, cursor?: string) {
    if (!token) return;
    const mySeq = ++seq.current;
    setLoading(true); setError(false);
    try {
      const r = await listCompanies(token, { q: query, after: cursor, limit: 25 });
      if (mySeq !== seq.current) return;
      if (r.error) { setError(true); return; }
      setItems(prev => cursor ? [...prev, ...r.items] : r.items);
      setAfter(r.after);
    } catch {
      if (mySeq === seq.current) setError(true);
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }

  // Debounced reload on query change (immediate for the initial/cleared box). Load-more calls load() directly.
  useEffect(() => {
    if (!token) return;
    const t = setTimeout(() => { void load(q); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, token]);

  function onCreateDeal(seed: NewDealSeed) {
    navigate("/board", { state: { newDeal: seed } });
  }

  const showEmpty = !loading && !error && items.length === 0;

  return (
    <div className="dc-wrap">
      <div className="dc-header">
        <h1 className="dc-title">Companies</h1>
        {!!items.length && <span className="dc-sub">{items.length}{after ? "+" : ""}</span>}
      </div>

      <div className="dc-toolbar">
        <div className="dc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input className="dc-input" placeholder="Search companies by name or domain" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>

      <div className="dc-panel">
        <div className="dc-table-scroll">
          <table className="dc-table">
            <thead><tr>
              <th>Company</th><th>Domain</th><th>Industry</th><th>Location</th><th>Owner / Sales user</th><th>Created</th>
            </tr></thead>
            <tbody>
              {loading && items.length === 0
                ? Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={6}><div className="dc-skeleton" /></td></tr>)
                : error && items.length === 0
                ? <tr><td colSpan={6}><div className="dc-empty">Companies unavailable. <button className="dc-btn dc-btn-sm" onClick={() => void load(q)}>Retry</button></div></td></tr>
                : showEmpty
                ? <tr><td colSpan={6}><div className="dc-empty">No companies match.</div></td></tr>
                : items.map(c => {
                    const label = c.name || c.domain || "Company";
                    return (
                      <tr key={c.hubspotId} onClick={() => setOpen(c)}>
                        <td>
                          <div className="dc-deal">
                            <span className="dc-avatar" style={{ background: avatarFor(label) }}>{initials(label)}</span>
                            <span className="dc-deal-name" title={label}>{label}</span>
                          </div>
                        </td>
                        <td className={c.domain ? "" : "dc-mut"}>{orDash(c.domain)}</td>
                        <td className={c.industry ? "" : "dc-mut"}>{orDash(c.industry)}</td>
                        <td className="dc-mut">{orDash([c.city, c.state].filter(Boolean).join(", "))}</td>
                        <td className="dc-trunc">{orDash(c.ownerName || c.salesUser)}</td>
                        <td className="dc-mut" style={{ whiteSpace: "nowrap" }}>{fmtCompanyDate(c.createdate)}</td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
        {after && !showEmpty && (
          <div style={{ display: "flex", justifyContent: "center", padding: 12 }}>
            <button className="dc-btn dc-btn-ghost dc-btn-sm" disabled={loading} onClick={() => void load(q, after)}>
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {open && <CompanyDrawer company={open} token={token} onClose={() => setOpen(null)} onCreateDeal={onCreateDeal} />}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build + commit**

Run (from `monday-app/`): `npm run build` → passes.

```bash
git add monday-app/src/views/CompaniesView.tsx
git commit -m "feat(app): CompaniesView directory (search, list, load-more, states)"
```

---

## Task 9: App tab strip + `/companies` route + styles

**Files:**
- Modify: `monday-app/src/App.tsx`
- Modify: `monday-app/src/styles.css`

- [ ] **Step 1: Add the tab strip + route**

Replace the body of `monday-app/src/App.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import mondaySdk from "monday-sdk-js";
import BoardView from "./views/BoardView";
import CompaniesView from "./views/CompaniesView";
import { ConfirmProvider } from "./confirm";

const monday = mondaySdk();

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const apply = (t?: string) => setTheme(t === "dark" || t === "black" ? "dark" : "light");
    monday.get("context").then((res: any) => apply(res?.data?.theme));
    monday.listen("context", (res: any) => apply(res?.data?.theme));
  }, []);

  return (
    <div className="dc-root" data-theme={theme}>
      <ConfirmProvider>
        <BrowserRouter>
          <nav className="dc-topnav">
            <NavLink to="/board" className={({ isActive }) => "dc-topnav-tab" + (isActive ? " on" : "")}>Deals</NavLink>
            <NavLink to="/companies" className={({ isActive }) => "dc-topnav-tab" + (isActive ? " on" : "")}>Companies</NavLink>
          </nav>
          <Routes>
            <Route path="/board" element={<BoardView />} />
            <Route path="/companies" element={<CompaniesView />} />
            <Route path="*" element={<Navigate to="/board" replace />} />
          </Routes>
        </BrowserRouter>
      </ConfirmProvider>
    </div>
  );
}
```

- [ ] **Step 2: Add the styles**

Append to `monday-app/src/styles.css`:

```css
/* --- Companies tab --- */
.dc-topnav { display: flex; gap: 4px; padding: 8px 20px 0; border-bottom: 1px solid var(--border); }
.dc-topnav-tab { padding: 8px 14px; border-radius: 8px 8px 0 0; font-weight: 600; font-size: 14px;
  color: var(--mut); text-decoration: none; border-bottom: 2px solid transparent; }
.dc-topnav-tab:hover { color: var(--text); }
.dc-topnav-tab.on { color: var(--accent); border-bottom-color: var(--accent); }

.dc-drawer-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.dc-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px; }
.dc-detail-label { font-size: 12px; color: var(--mut); }
.dc-detail-value { font-size: 14px; word-break: break-word; }
.dc-detail-desc { font-size: 14px; color: var(--text); white-space: pre-wrap; margin: 4px 0 0; }

.dc-contact-list { display: flex; flex-direction: column; gap: 8px; }
.dc-contact-row { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.dc-contact-info { display: flex; flex-direction: column; min-width: 0; }
.dc-contact-name { font-weight: 600; font-size: 14px; }
.dc-contact-actions { display: flex; gap: 6px; flex-shrink: 0; }
```

Note: `--border`, `--mut`, `--accent`, `--text` are existing CSS variables in `styles.css`. If any name differs, match the names already used elsewhere in that file (grep `--` in `styles.css`).

- [ ] **Step 3: Typecheck + full app tests + build + commit**

Run (from `monday-app/`): `npm test` → all pass. `npm run build` → passes.

```bash
git add monday-app/src/App.tsx monday-app/src/styles.css
git commit -m "feat(app): Companies tab strip + /companies route + styles"
```

---

## Task 10: Deploy + end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Deploy the worker**

Run (from `worker/`): `./node_modules/.bin/wrangler deploy`
Expected: uploads, prints a new Version ID.

- [ ] **Step 2: Smoke `/app/companies` (default listing) live**

Using a valid session token or the trigger-secret-authorized path is not available for `/app/*` (session-token only). Instead verify via the app in monday (Step 4), and confirm the Worker route exists by checking the deploy logs / `wrangler tail` for `[app/companies]` only on error. (No unauthenticated curl — `/app/*` requires a monday session token.)

- [ ] **Step 3: Full test + build gate**

Run (from `worker/`): `./node_modules/.bin/tsc --noEmit` && `./node_modules/.bin/vitest run` → all green.
Run (from `monday-app/`): `npm test` && `npm run build` → all green.

- [ ] **Step 4: Manual verification in monday (test data; no cleanup needed — read-only + a test deal)**

1. Open the Deal Cockpit board view → the **Companies** tab appears; clicking it shows newest-created companies.
2. Type ≥2 chars → results narrow to name/domain matches; clearing returns to the default newest-first list; fast typing shows no stale results.
3. **Load more** appends the next page; disappears at the end.
4. Open a company → details show resolved **industry/type/partner-with/sales-user labels** (not raw codes), formatted employees/revenue, a working LinkedIn link, ↗ HubSpot, ↗ monday card.
5. Contacts list shows **name · email · title**, each with ↗ HubSpot; a company with no links reads "No linked contacts".
6. **＋ Create deal** (company header) → lands on the Deals tab with a new-deal drawer, company pre-linked in Associations; Save creates the deal linked to that company (verify in HubSpot). Delete the test deal after.
7. A contact row's **＋ Deal** → new-deal drawer pre-linked to company **and** that contact.
8. Back/refresh after creating does not reopen the drawer (router state cleared).

- [ ] **Step 5: Update the memory pointer (optional)**

If the Deal Cockpit memory note should reflect the new tab, update `memory/deal-cockpit-app.md` accordingly (the user maintains memory; only do this if asked).

---

## Self-review checklist (run after implementing all tasks)

- All new/changed exports referenced by later tasks exist: `companySearchBody`, `mapCompanyResult`, `listCompanies`, `mapAssocRecord`, `CompanyHit`, `COMPANY_LIST_PROPS` (worker); `Company`, `CompanyContact`, `listCompanies`, `getCompanyContacts` (worker-client); `buildDealSeed`, `NewDealSeed`, `fmtNumber`, `orDash`, `fmtCompanyDate` (lib/companies).
- No read-only/calculated HubSpot props are ever written (this feature is read-only on companies).
- `/app/associations` change is additive — the companies branch shape (`{hubspotId,name}`) is unchanged, so the deal-form auto-associate is unaffected.
- Every enum field on the company detail is label-resolved via `ctx.labels`; owner via `ctx.ownersById`.
```

# Association Display Cascade + HubSpot Links — Design

**Date:** 2026-07-24
**Status:** approved for implementation

Two small, related improvements to how the Deal Cockpit app shows a deal's linked contacts/companies. Both are **app-only** — no worker, sync, board, or schema changes.

---

## Feature A — smart display-name cascade

**Problem.** When a synced contact has no first name (or a company no domain), the monday card name is the worker's fallback `contacts <hubspotId>` / `companies <hubspotId>` (`itemName` in `worker/src/mapping.ts`). The app displays that raw fallback in the deal's Company/Contact columns and its association chips.

**Fix.** A pure display helper that, when the name is a fallback, cascades to other fields the card already carries. The fallback string encodes the type, so one function handles both boards.

`monday-app/src/lib/link-name.ts`:
```ts
// c1 = text_mm4scke9  (contact: lastname · company: name)
// c2 = text_mm4p2bvb  (contact: email   · company: city — deliberately NOT used for companies)
const FALLBACK_RE = /^(contacts|companies) \d+$/;

export function linkDisplayName(name: string, c1: string, c2: string): string {
  const m = FALLBACK_RE.exec(name.trim());
  if (!m) return name;                                     // a real firstname / domain
  if (m[1] === "contacts") return c1.trim() || c2.trim() || name;  // lastname → email → keep id
  return c1.trim() || name;                                // company: name → keep id (never city)
}
```

Cascades:
- **Contact:** firstname → lastname → email → `contacts <id>`
- **Company:** domain → company name → `companies <id>`

**Where it's applied** — the two functions in `monday-app/src/monday-client.ts` that resolve linked cards to names, extended to also fetch `text_mm4scke9` + `text_mm4p2bvb` and return the cascaded name so callers change nothing:
- `getItemNames` → feeds the board table's Company/Contact columns (via `useBoard.rawItemToRow`).
- `getCardsByIds` → feeds the drawer's association chips (via `DealDrawer`).

**Why the regex is safe:** the worker's fallback is exactly `${object} ${rec.id}` (object ∈ {contacts, companies}, id numeric). A real firstname or a domain (which contains dots) cannot match `^(contacts|companies) \d+$`.

**Already correct, not touched (verified):**
- The staged "+ New" labels (`lib/assoc.ts`) already cascade.
- The **search-results list** builds names in the worker's `mapSearchResult`: contacts `firstname+lastname → email → "(no name)"`, companies `name → "(no name)"`. It never emits the `contacts <id>` fallback, so it needs no change.
- Only *existing linked* records read back from the board (via `getItemNames` / `getCardsByIds`) show the raw fallback — which is exactly the surface this fixes.

---

## Feature B — open a linked contact/company in HubSpot

**Problem.** The Edit Deal drawer can open the deal in HubSpot (`↗ HubSpot`), but there's no way to open a linked contact or company.

**Fix.** A small `↗` icon on each linked association chip that has a HubSpot id, opening that record in a new tab.

`monday-app/src/board-config.ts` — generalize the existing deal-URL helper:
```ts
const HS_OBJ = { contacts: "0-1", companies: "0-2" } as const;
export const hubspotRecordUrl = (kind: "contacts" | "companies", id: string) =>
  `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/${HS_OBJ[kind]}/${id}`;
```

`monday-app/src/views/AssociationPicker.tsx` — in each chip, before the remove `×`, add the link only when `a.hubspotId` is set (a staged "+ New" record has none, so it correctly shows no link):
```tsx
<span className="dc-chip">{a.label}
  {a.hubspotId && (
    <button type="button" className="dc-chip-link" title="Open in HubSpot"
      onClick={() => openLink(hubspotRecordUrl(kind, a.hubspotId!))} aria-label="Open in HubSpot">↗</button>
  )}
  <button onClick={() => remove(a)} aria-label="Remove">×</button>
</span>
```
`kind` is already the picker's prop (`"contacts" | "companies"`), and `openLink` is imported from `monday-client`. A small `.dc-chip-link` style keeps the `↗` visually distinct from the `×`.

`AssociationPicker` is shared, so the `↗` also appears in the standalone Contact/Company drawer's nested associations — a useful bonus, not a regression.

---

## Testing

| Change | Test | Rationale |
|---|---|---|
| A — `linkDisplayName` | ✅ `monday-app/src/lib/link-name.test.ts` (pure) | every branch (below) |
| A — `getItemNames` / `getCardsByIds` fetch | — `tsc` + review | monday-SDK I/O, not unit-tested in this app |
| B — `hubspotRecordUrl` | ✅ can be a trivial assertion in the same or a small test | pure string builder |
| B — chip `↗` | — `tsc` + build + visual | React render |

`linkDisplayName` cases:
1. real firstname → returned unchanged (`"Emily", _, _` → `"Emily"`)
2. real domain → returned unchanged (`"cxmt.com", _, _` → `"cxmt.com"`)
3. contact fallback + lastname → lastname (`"contacts 1", "Smith", "a@b.co"` → `"Smith"`)
4. contact fallback, no lastname, has email → email (`"contacts 1", "", "a@b.co"` → `"a@b.co"`)
5. contact fallback, nothing → keep id (`"contacts 1", "", ""` → `"contacts 1"`)
6. company fallback + name → name (`"companies 2", "Acme Inc", "Shanghai"` → `"Acme Inc"`)
7. company fallback, no name → keep id, NOT city (`"companies 2", "", "Shanghai"` → `"companies 2"`)

Both workspaces stay green: app `tsc` + `vitest` + `vite build`. (No worker change.)

## Non-goals

- No change to the worker, the sync, `itemName`, or any monday board/card name (the reverse-sync-risk path we deliberately avoided).
- No change to the staged "+ New" label logic (already correct).
- No "open in HubSpot" on search *results* (scope is linked records); can be added later if wanted.

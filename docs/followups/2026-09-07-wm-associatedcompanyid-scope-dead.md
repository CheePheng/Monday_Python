# PRODUCTION FOLLOW-UP — WM contacts `scopeAlsoLinkedProp` looks dead

**Status:** logged, NOT fixed. Unrelated to the CRM project; do not change it on `feat/monday-crm-sync`.
**Found:** 2026-09-07, while measuring HubSpot association data for the CRM board schema.
**Affects:** the LIVE Work Management sync (`CONTACTS_MYLA`), not the CRM sync.

## What it claims to do

`worker/src/config.ts:206`

```ts
  // Union scope: keep sales_user-owned contacts AND include company-linked ones (Phase 2 associations).
  scopeAlsoLinkedProp: "associatedcompanyid",
```

Two places consume it:

- `recInScope` (`sync.ts:459`) — a contact is in scope if that property is non-empty, **OR** it passes the
  `sales_user` + `createdate` gate.
- `searchModifiedIds` (`hubspot.ts:508`) — adds a second OR'd filter group,
  `associatedcompanyid HAS_PROPERTY`.

So the intent is: contacts linked to a company are in scope even without a `sales_user`.

## Why it appears to be inert

**`associatedcompanyid` does not exist as a property in this HubSpot portal.**

- `get_properties(contacts, ["associatedcompanyid"])` returns it under `propertiesNotFound`.
- A **full** untrimmed record dump (contact `520796719820`, every default property) does not contain it.
  It *does* contain `last_associated_company_name`, which HubSpot maintains instead.

If the property genuinely does not exist:

- `recInScope`'s union branch reads `rec.properties["associatedcompanyid"]` → `undefined` → `""` → the
  branch **never fires**, so scope collapses back to `sales_user` + `createdate` alone.
- `searchModifiedIds`' extra filter group matches **nothing**, so the union in discovery is also inert.

Net effect: the "also include company-linked contacts" extension is silently doing nothing, and
company-linked contacts without a `sales_user` are **not** being synced to the WM contacts board.

## Why it is not obviously broken

Nothing errors. An absent property is simply absent in the fetch, and HubSpot's search accepts a filter
on an unknown property without complaint. It fails **silently and open** — the sync keeps working, just
with narrower scope than the config claims. This is exactly the shape of the CRM `sales_user` problem,
in the opposite direction.

## Before changing anything, verify

1. Confirm with a direct authenticated call (not the MCP, which may hide legacy/hidden properties):
   `GET /crm/v3/properties/contacts/associatedcompanyid`. A 404 confirms it.
2. If confirmed absent, decide the intended replacement. `last_associated_company_name` exists but is a
   **display name**, so gating scope on it would be matching-by-name — against the project's standing
   invariant. The correct source is the contact→company **association**, not a property.
3. Measure the blast radius first. Widening WM contact scope would pull in a large number of previously
   out-of-scope contacts: of the 2,320 contacts created since 2026-06-01, **1,202** have at least one
   associated company and **1,118** have none. Many of those 1,202 are presumably already in scope via
   `sales_user`, but the overlap has not been measured.

**Do not "fix" this by widening scope without a measured count and an explicit decision** — that is how
a quiet config line becomes a mass card-creation event on a live board.

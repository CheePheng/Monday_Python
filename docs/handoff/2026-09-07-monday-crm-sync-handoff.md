# Handoff — HubSpot ↔ monday CRM two-way sync (Phase 1: Contacts + Accounts)

**Written:** 2026-09-07 · **Status:** AUTHORITATIVE — supersedes all earlier drafts and chat discussion
**Repo:** same GitHub repo · **Worktree:** `C:\Users\PC\Downloads\DKM_Project\Monday_Python-crm`
**Branch:** `feat/monday-crm-sync` · **Base:** `8088e94` (green, matches production)
**Production branch (do not disturb):** `feat/deals-single-board`
**Owner:** Woody (`cheep@wzbgroup.my`)

> **The rule to keep repeating to yourself:**
> **Two monday cards for the same HubSpot record are acceptable. Two systems writing the same HubSpot record are not.**

---

## 0. Phase 1 scope — fixed

Build a **second** HubSpot ↔ monday integration for the native **monday CRM** product, while the existing **HubSpot ↔ monday Work Management** sync stays live in production.

### In scope

- HubSpot **Contacts** ↔ monday CRM **Contacts**
- HubSpot **Companies** ↔ monday CRM **Accounts**
- **New records going forward only**
- Two-way field updates for records the CRM sync owns
- HubSpot delete → delete the CRM item
- monday delete → **never** delete HubSpot

### Explicitly NOT in scope

Historical import / backfill · Deals · Leads · Activities · Forms · Lark notifications · Quotes · Products · Line items · Contact↔Account association migration · Active/Inactive group mapping

### Target boards (verified via monday API 2026-09-07)

| Entity | Board name | ID | Items | Groups (verified) |
|---|---|---|---|---|
| Contacts | `Contacts` | `5028000495` | 5 | `topics` = "Active Contacts" · `new_group95562` = "Inactive Contacts" |
| Companies | `Accounts/Companies` | `5028000496` | 3 | `topics` = "Companies" · `group_mm6t6ear` = "Accounts/companies" |

URLs: `https://dkmecosystem.monday.com/boards/5028000495` · `https://dkmecosystem.monday.com/boards/5028000496/views/52891367`

### The eight existing rows (verified: all have EMPTY HubSpot ID and EMPTY Sync State)

**Contacts `5028000495`:** Robert Thompson · Sam Jones · Steven Scott (all created 2026-04-22, monday CRM template seed data) · 新的 contact (2026-07-07) · test (2026-08-27) — the last two are manual tests.

**Accounts `5028000496`:** Google · Apple · Amazon (all created 2026-04-22, template seed data).

None is a synced business record. **See §13 — these are a production-data hazard.**

---

## 1. Worktree setup (already done)

```bash
# Already executed — recorded for reference:
git worktree add ../Monday_Python-crm -b feat/monday-crm-sync 8088e94
cd ../Monday_Python-crm/worker && npm install
cd ../monday-app && npm install
```

Verify the baseline before changing anything:

```bash
cd worker        && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run   # expect 340 passed
cd ../monday-app && npm run build && ./node_modules/.bin/vitest run                      # expect 195 passed
```

If those numbers don't match, stop and investigate — you are not on a clean base.

**The interrupted work from the previous session is parked on `wip/drawer-review-round2` (`584d8b2`).** It contains a broken `monday-app` build and an unsafe association-pagination change. Do not merge or deploy from it.

---

## 2. Existing production system — do not break it

```
HubSpot ⇄ Cloudflare Worker ⇄ monday Work Management
```

| Thing | Value |
|---|---|
| Production Worker | `hubspot-monday-sync` · `https://hubspot-monday-sync.askada.workers.dev` |
| Deployed version | `b121f65c` (= commit `8088e94`) |
| HubSpot portal | `39939588` |
| monday integration account | `ask ada` / `askada@dkmeco.com.sg` / user id `104118038` |
| WM Deals board | `5029480547` (subitems `5029480548`) |
| WM Contact Follow Up | `5029639630` |
| WM Company Follow Up | `5029639440` |

The old sync must keep serving its existing Work Management workflows throughout.

---

## 3. Reuse the engine — do not fork it

The Worker is config-driven. CRM support is primarily **new `ObjectSpec` configuration**, not a second engine.

Reuse: `sync.ts` · `reconcile.ts` · `mapping.ts` · `associations.ts` · `monday.ts` · `hubspot.ts` · `webhooks.ts` · `ensure-card.ts` · `card-registry.ts` · `create-idempotency-do.ts`

Extension point: `ObjectSpec` / `SPEC_BY_BOARD`. Keep CRM and WM specs **disjoint**.

Do **not** restructure into `shared/` + `legacy/` + `crm/` engine copies. Split only configuration:

```
worker/src/
  sync.ts  reconcile.ts  mapping.ts  associations.ts  monday.ts  hubspot.ts  webhooks.ts  ...
  config/
    wm.ts
    crm.ts
```

Shared engine changes are allowed **only** where the ownership model genuinely requires them (see §8 Prerequisite C) — explicit, tested, and shared by both Workers.

---

## 4. Separate Cloudflare deployment — mandatory

Own Worker name, secrets, webhook routing, bindings, Durable Object namespace, and config. Suggested name: `hubspot-monday-crm-sync`. Wrangler environments are preferred if they keep one codebase with two isolated deployments.

**Never deploy CRM code over `hubspot-monday-sync`.**

Initial state: **crons OFF**, `DRY_RUN="true"`.

---

## 5. No historical import — webhook-first

Phase 1 must not import the historical HubSpot Contact/Company dataset, and must not build a full historical sweep.

```
New/updated HubSpot Contact  --webhook-->  CRM Worker  -->  monday CRM Contact
New/updated monday CRM Contact --webhook-->  CRM Worker  -->  HubSpot Contact
```

Same pattern for Company ↔ Account.

**Incremental drift net:** the 10-minute cron may be enabled later, after webhook behaviour is proven. If enabled it must obey CRM ownership and must never discover/import historical records. **The 03:00 full sweep stays OFF** for CRM Contacts/Accounts permanently — do not reintroduce a 44k-record search-based sweep.

---

## 6. Write ownership — the core architecture

Two independent two-way syncs cannot both write the same HubSpot record. A pure `createdate >= CUTOVER` rule is **not sufficient**, because:

1. the old WM Contact/Company specs have `createFromMonday: true` today, so the old Worker can mint post-cutover HubSpot records that a date-only rule would wrongly assign to CRM;
2. monday→HubSpot events need no date check — the originating board already identifies the path;
3. old WM Deals still need Contact/Company cards for relation display, so the old Worker may legitimately maintain **mirror cards** for CRM-owned records.

**Ownership means permission to write HubSpot.** Signal: a HubSpot custom property on **both** Contacts and Companies:

```
sync_owner = wm | crm
```

`sync_owner` is primary. `CRM_CUTOVER_AT` is a fallback for **unstamped** records only.

### Two separate predicates — do NOT merge them

```
canWriteHubSpot(record):
    return record.sync_owner == "crm"          // CRM Worker
                                                // (old Worker: see below)

canClaimCrmOwnership(record):
    return record.sync_owner is empty
       AND record.createdate >= CRM_CUTOVER_AT
       AND record qualifies for CRM scope
```

**The claim is a separate operation, not an exception inside the write guard.** Keeping them separate means the claim path can never decay into a general bypass.

Claim flow:

```
Unstamped new HubSpot record
   → canClaimCrmOwnership() == true
   → PATCH ONLY { sync_owner: "crm" }      <-- single property, nothing else
   → refetch / update local record state
   → canWriteHubSpot() now true
   → continue normal sync
```

The claim PATCH **must contain only `sync_owner`**. Any other property in that payload is a bug.

### Symmetric write predicates

```
Old WM Worker may write HubSpot iff
      sync_owner == "wm"
   OR (sync_owner is empty AND createdate <  CRM_CUTOVER_AT)

CRM Worker may write HubSpot iff
      sync_owner == "crm"
```

Unstamped + pre-cutover ⇒ WM-owned. **No backfill of `sync_owner=wm` onto the existing ~44k records** — the fallback already covers them, and a mass write buys nothing while adding risk.

### monday → HubSpot origin

Never infer a monday event's origin from a HubSpot date. Route by board/spec (`SPEC_BY_BOARD` already does this), then enforce the `sync_owner` write guard before any HubSpot mutation.

---

## 7. Old Deal associations require read-only WM mirrors

Deals stay on the old sync in Phase 1, and `associations.ts` creates Contact/Company cards on demand to populate Deal relation columns. So the same real-world record may intentionally exist twice in monday.

For a **CRM-owned** record:

| Direction | Allowed? |
|---|---|
| HubSpot → monday CRM | Yes |
| monday CRM → HubSpot | Yes |
| HubSpot → old WM mirror card | Yes, where a legacy Deal association needs it |
| old WM mirror card → HubSpot | **Never** |

Never stamp `sync_owner=wm` merely because the old Worker created a relation mirror. Add tests proving an association-created WM mirror for a CRM-owned record cannot write **any** HubSpot property.

---

## 8. Ownership prerequisites — sequence before cutover

### Prerequisite A — HubSpot schema
Create `sync_owner` on **both** Contacts and Companies (values `wm` | `crm`). Record the exact internal property name in config if HubSpot generates a different one.

### Prerequisite B — old Worker guard **and fetch list**
The production Worker must read and enforce `sync_owner` before any Contact/Company HubSpot write. **Two parts, both required:**

1. the guard itself;
2. **the properties must actually be fetched.** `propertiesForSpec` builds the HubSpot property list from `nameProps + modifiedProp + fields + groupBy.prop`. If `sync_owner` and `createdate` aren't in it, they arrive `undefined` and every record silently mis-classifies as unstamped.

Model them as explicit infrastructure concepts, always fetched regardless of the mapped field list:

```
ownershipProp:        "sync_owner"
ownershipCreatedProp: "createdate"
```

**Do not expose `sync_owner` as a monday CRM column.** It is infrastructure metadata, not a user-facing field.

This is a production code change — **explicit approval gate before deploy.**

### Prerequisite C — shared engine hook
There is no per-record ownership hook before HubSpot mutations today. Add **one** small, tested write-authorization predicate in the shared engine, used by both Workers, consulted before: reverse field patches · Contact creation · Company creation · explicit app-save writes · every other HubSpot mutation path for these objects. Do not scatter ownership checks across files.

---

## 9. Cutover: stop creation from the old WM boards

At production cutover:

```
old Contacts:  createFromMonday = false
old Companies: createFromMonday = false
```

After cutover, new Contacts/Accounts are created through monday CRM. The old WM boards keep their historical two-way records and read-only association mirrors. **Production change — approval gate required.**

---

## 10. Controlled rollout

| Phase | Settings | Behaviour |
|---|---|---|
| **A — dry run** | `DRY_RUN=true` | No monday writes, no HubSpot writes. Inspect mappings and intended writes. |
| **B — one-way** | `dryRun=false`, `writeHubspot=false` | **Real** HubSpot → monday CRM writes; **all** HubSpot mutations blocked. **No ownership claiming in this phase** — a claim is itself a HubSpot write. |
| **C — scoped two-way** | prerequisites live | Create `sync_owner` properties, deploy both guards, stamp a **tiny** known test set `sync_owner=crm`, enable CRM→HubSpot for only those. Verify the old Worker rejects them. No separate marker property needed — `sync_owner=crm` *is* the test scope. |
| **D — production cutover** | approved | Deploy old-Worker guard; set old `createFromMonday=false`; approve `CRM_CUTOVER_AT`; enable CRM ownership + reverse writes for CRM-owned records; old WM stays two-way for WM-owned records; optionally enable the 10-minute drift net. |

The engine already separates `dryRun` from `writeHubspot` — **reuse it rather than building another one-way mode.**

---

## 11. Phase 0 — board schema audit before any sync code

Audit both boards via the monday API before writing the CRM `ObjectSpec`s. The boards mix native CRM fields with temporary HubSpot-sync text stubs. With only 8 rows total, now is the cheapest possible time to fix them.

### Correction: HubSpot ID as **text** is correct — keep it

The engine does **not** require a numbers column. Verified: `colText` reads `column_values.text` (type-agnostic), and `findItemByColumn` matches through `items_page_by_column_values` with `column_values: [String!]!` (string matching). `mapping.ts`'s `numbers` case applies to mapped *fields*, not the id column.

Text is in fact **safer**: a numbers column can render a 12-digit id with separators or in scientific notation, which would break the exact string match the lookup depends on.

**Keep these as text** (do not retype to imitate the old board):

- `text_mm6t71dj` — HubSpot ID (Contacts) · `text_mm6twy4w` — Sync State (Contacts)
- `text_mm6tsnwx` — HubSpot ID (Accounts) · `text_mm6tccd0` — Sync State (Accounts)

### Contacts board `5028000495` — decisions (verify exact ids/types via API first)

| Area | Current | Direction |
|---|---|---|
| HubSpot ID `text_mm6t71dj` | text | **KEEP text** |
| Sync State `text_mm6twy4w` | text | **KEEP text** |
| HubSpot Link `text_mm6t8x04` | text stub | prefer `link` if a technical link is wanted |
| Contact Owner `text_mm6s7db3` | text stub | **`people`** — required for `appReverse` owner safety |
| Sales Users `text_mm6sakj3` | text stub | **`people`** if in scope |
| Associated Company `text_mm6twb9d` | text stub | prefer native `contact_account` (board_relation) when associations land |
| Email | native `contact_email` (email) exists | **use the native column** |
| Phone | `contact_phone` (phone) **and** `numeric_mm6swz9c` (numbers) | **use native `contact_phone`.** Never a numbers column — it destroys leading `+` and zeros and breaks the phone-loop invariant. Decide the numbers column's fate. |
| Last name | **duplicates**: `text_mm6snp6r`, `12849070_last_name` | choose one authoritative column |
| Contact Source `text_mm6sc26t` | text | HubSpot `leadsource` is an **enum** — needs dropdown/status with explicit label↔internal-value mapping, or make it forward-only |
| Vendors `text_mm6s40ew` | text | same enum rule (`manufacturer__c`) |
| `custom_mkrm9y8c` Activities timeline | `unsupported` (proprietary) | never write via normal column sync |
| `mirror2`, `account_deal` | mirror | read-only, never write |

### Accounts board `5028000496` — identity decisions

Competing identity/display concepts: item `name` · `text_mm6t1q4h` "Company Name" · `text_mm6tyx9z` "Company domain name" · `company_domain` (link). Choose and document exactly one column for each of: **display item name**, HubSpot `name`, HubSpot `domain`, **adoption key**. Do not reverse-parse a display name into multiple HubSpot properties.

### Item-name rule

`nameReverse` supports a **single** HubSpot property. So a `First Last` item name must be treated as **display/derived only** — sync `firstname` and `lastname` through their own columns. Same for Accounts unless one exact property is deliberately chosen.

### Group decision — Phase 1

```
Contacts  5028000495:  singleGroup = "topics"    // Active Contacts
Accounts  5028000496:  singleGroup = "topics"    // Companies
```

**The engine enforces group placement continuously, not just at creation** — verified: `reconcile.ts:88` emits a `group` diff whenever `targetGroup(rec, spec) !== item.group.id`, and `sync.ts:139` moves the item on any group diff. So a rep dragging a contact into **Inactive Contacts** will have it **moved back**.

Therefore, during Phase 0 either:

- **rename** `new_group95562` to make its status obvious, e.g. **"Inactive Contacts (future — not synced)"**, or
- **remove** it, only if API inspection confirms it is unused template data.

**Do not implement Active/Inactive mapping in Phase 1**, and do not let anyone assume moving a contact to Inactive means anything in HubSpot. When you do want it later, map the groups to a real HubSpot property via `groupBy: { prop, map, reverse: true }` — the pattern the Deals board already uses. Do not add new engine behaviour just for this.

The Accounts board's two groups ("Companies" and "Accounts/companies") are redundant — flag in the Phase 0 proposal; do not delete blindly.

---

## 12. The eight demo rows — explicit decision required

Before enabling CRM→HubSpot creation: inspect each row via API one final time · confirm HubSpot ID and Sync State are still empty · confirm no real data was added · classify each as `template` / `test` / `real` · then delete the template/test rows, or retain them behind the create cutoff.

**Recommended: delete the eight confirmed demo/test rows before Phase C.** Log the decision; never delete silently.

---

## 13. CRM-specific create cutoff — required safeguard

The engine has `CREATE_CUTOFF_MS` so old monday cards are never pushed into HubSpot. **The existing value `2026-07-03` does NOT protect all the demo rows** — `新的 contact` is 2026-07-07 and `test` is 2026-08-27.

So the CRM specs need **their own** create cutoff set at the approved go-live point.

Note the asymmetry: the plan carefully prevents importing HubSpot history into monday, but without this, monday's existing junk (Google, Apple, Amazon, "test") would be **exported into the production HubSpot portal** the moment `createFromMonday` is enabled.

**Do both:** clean the demo rows *and* set a CRM create cutoff as defence in depth.

---

## 14. Contact creation / adoption

**HubSpot → CRM:** for a new in-scope Contact, create/ensure one CRM Contact · store the exact HubSpot id in the text id column · store/update Sync State · use ensure-card/idempotency · repeated webhook delivery must never duplicate.

**CRM → HubSpot:**

1. require a usable **normalized email**;
2. search HubSpot by that email;
3. **if found, ADOPT** the existing Contact and store its id;
4. only create when no match exists;
5. in Phase C/D, stamp `sync_owner=crm` (see §6 — via the claim path, or in the creation payload).

Never match Contacts by name. Email is an identity/adoption key and must never be silently cleared.

---

## 15. Company / Account creation / adoption

**HubSpot → CRM:** as above, for Companies → CRM Accounts.

**CRM → HubSpot:** automatic creation **requires a usable domain**.

1. normalize the domain; 2. search HubSpot by domain; 3. adopt if found; 4. otherwise create and stamp ownership.

**Never match Companies by name alone** — "ABC Trading", "ABC Trading Sdn Bhd" and "ABC Trading Malaysia" are different records.

**No domain ⇒ do not auto-create.** Record a clear reason (e.g. `needs_company_domain`) and let the next valid domain edit retrigger adoption/creation.

---

## 16. Two-way update rules

For CRM-owned records holding a HubSpot id: HubSpot changes → update CRM; CRM changes → update HubSpot. Preserve every existing invariant:

1. never clear/overwrite a non-empty HubSpot value because monday is blank;
2. never match by name;
3. normalize diffable fields on **both** sides;
4. Sync State uses HubSpot `lastmodifieddate`, not monday `updated_at`;
5. owner/assignment fields stay `appReverse` (explicit intent only);
6. passive reconciliation never silently overwrites a HubSpot owner;
7. reverse associations stay additive-only unless an explicit unlink path exists;
8. only write fields that actually changed;
9. phone normalization is canonical and identical on both sides.

---

## 17. Delete rules — fixed

**HubSpot → monday:** an in-scope HubSpot Contact/Company deletion deletes the corresponding CRM item.

**monday → HubSpot:** a CRM item deletion **never** deletes the HubSpot record. Log it. monday deletion is not destructive permission in HubSpot.

There is no historical sweep in Phase 1. If a later valid HubSpot webhook arrives for a still-existing record whose CRM item was deleted, normal idempotent ensure-card behaviour may recreate the card. **Document this**; do not build a bulk recreation loop.

---

## 18. Webhooks and subscriptions

Separate webhook endpoints and subscriptions for the CRM Worker. **Separate URLs alone do not solve the shared-HubSpot collision** — both apps can receive events for the same records, so every HubSpot mutation must pass the §6–§8 ownership guard.

### monday registration — event-name trap

Register with the **subscription enum**, which differs from the delivered payload's `event.type`:

| Purpose | Register (create_webhook enum) | Delivered payload may say |
|---|---|---|
| item created | **`create_item`** | `type: "create_pulse"` |
| column changed | `change_column_value` | same |
| name changed | `change_name` | same |
| item deleted | `item_deleted` | same |

**Never use payload `event.type` names as registration enums.** Register on **both** CRM boards (`5028000495`, `5028000496`), pointed at the **new** Worker. Registration is idempotent — query existing webhooks first (`worker/scripts/register-subitem-webhook.mjs` is the pattern). An invalid enum fails loudly at registration, so verify empirically.

### HubSpot subscriptions

Use a **second HubSpot app** with its own subscriptions and its own signing secret, so the production Worker stays isolated. Subscribe to Contact and Company creation / propertyChange / deletion.

**Reuse the existing parser — do not write another one.** `worker/src/webhooks.ts` already handles **both** formats: the 2026 generic `object.creation` / `object.propertyChange` + `objectTypeId`, and the legacy `contact.*` / `company.*` / `deal.*`. Inspect the new app's actual version and use whichever format it emits; the handler copes with either.

---

## 19. Crons

**10-minute incremental** — drift net for missed webhooks. OFF during development; consider enabling before go-live; must obey `sync_owner` + cutover scope; must never import historical records.

**03:00 full sweep** — OFF for CRM Contacts/Accounts, long-term.

---

## 20. Tests required before production cutover

**Contact:** HubSpot new → CRM created · CRM new → HubSpot created · CRM new with existing HubSpot email → **adopted, not duplicated** · HubSpot update → CRM · CRM update → HubSpot · owner protection · phone normalization · enum mapping · duplicate HubSpot webhook · duplicate monday webhook · loop prevention · empty-value protection · Sync State conflict · HubSpot delete → CRM delete · monday delete → HubSpot survives.

**Company/Account:** HubSpot new → CRM Account · CRM new with domain → HubSpot created · CRM Account with existing domain → adopted · **CRM Account without domain → no HubSpot create + clear reason** · updates both ways · HubSpot delete → CRM delete · monday delete → HubSpot survives.

**Ownership / coexistence:** `sync_owner=wm` ⇒ CRM Worker cannot mutate HubSpot · `sync_owner=crm` ⇒ old Worker cannot mutate HubSpot · unstamped pre-cutover ⇒ old Worker writable · unstamped post-cutover ⇒ **not writable by both** · **`canClaimCrmOwnership` PATCHes only `sync_owner` and nothing else** · claim refused while `writeHubspot=false` · CRM-owned record may have a WM relation mirror · **that mirror cannot mutate HubSpot** · board origin decides the monday path · `createFromMonday=false` after cutover · CRM create cutoff blocks the pre-go-live demo rows · `sync_owner` and `createdate` are always present in the fetched properties.

**Rollout modes:** `dryRun=true` blocks all writes · `dryRun=false, writeHubspot=false` permits HubSpot→CRM but blocks **every** HubSpot mutation including ownership stamps.

---

## 21. Hard-won production invariants — preserve them

Each cost real debugging; several caused live data damage.

1. Never clear/overwrite HubSpot because monday is empty.
2. Never match by name. Use the stored HubSpot id after adoption/creation.
3. No sync loops — normalize both sides.
4. Sync State uses HubSpot `lastmodifieddate`, never monday `updated_at`.
5. Explicit app save carries intent; passive reconcile stays conservative.
6. **Ownership fields are `appReverse`** — a plain `reverse` on contact `hubspot_owner_id` once silently reassigned a live contact (HubSpot history showed only "Integration monday sync").
7. Reverse associations are additive-only unless intent is explicit.
8. Silently swallowed errors (`.catch(() => [])`) are defects, not error handling.
9. Respect the Cloudflare subrequest budget (~1000/request).
10. **monday `column_values{text}` is EMPTY for `board_relation`** — query `... on BoardRelationValue { linked_item_ids }`.
11. HubSpot association indexes are eventually consistent — preserve `clearsFromEmpty` / `resolvedAllIds` / `shrinksFreshCard`.
12. Phone normalization identical on both sides (digits, keep only a leading `+`).
13. Only write changed fields — rewriting untouched columns destroyed multi-value dropdowns and collapsed multi-person columns.
14. monday attributes every API write to the **token owner** (`ask ada`, id `104118038`) — keep the `[actor]` logging that distinguishes person from integration.
15. Cloudflare retains no Worker logs; `console.log` is live-only via `wrangler tail`.
16. Subitem webhooks register on the **parent** board but are delivered with the **subitems** board id — route by `boardId`, not event type.

---

## 22. Toolchain rules

- **`./node_modules/.bin/tsc --noEmit` — NEVER `npx tsc`** (wrong package).
- Tests: `./node_modules/.bin/vitest run` per package; `monday-app` also `npm run build`.
- `monday-app` has `noUnusedLocals` ON.
- Worker deploy: `./node_modules/.bin/wrangler deploy` from `worker/`.
- **graphify first** for codebase questions: `graphify query "<question>"`; `graphify update .` after changes. `.graphify_root` must be an **absolute Windows path** (an MSYS `/c/...` path silently no-ops the rebuild; `graphify update .` rewrites it to `.`, which also breaks it).
- No `Co-Authored-By: Claude` trailer — Woody is sole author.
- Don't commit `docs/` unless asked. Don't push unless asked. Never commit secrets.
- **No production deploy, HubSpot property creation, old-Worker scope change, `createFromMonday` change, or board column/item deletion without an explicit approval gate.**

---

## 23. Implementation sequence

### Phase 0 — discovery + proposals (no sync code)
1. Verify baseline tests/build (340 / 195).
2. Read this handoff completely.
3. Inspect the production Contact/Company specs and **every** HubSpot mutation path.
4. Inspect CRM Contacts `5028000495` and Accounts `5028000496` via the monday API.
5. Inspect HubSpot Contact and Company property schemas.
6. Verify the column ids/types/groups listed in §11 against live data.
7. Produce a column-by-column **KEEP / RETYPE / REPLACE / DELETE / FORWARD-ONLY** proposal.
8. Classify the eight demo rows.
9. Design the shared ownership write guard + `canClaimCrmOwnership`.
10. Design the `sync_owner` prerequisite/deploy sequence.
11. Design the CRM create cutoff.
12. **Review before any destructive board change.**

### Phase 1 — CRM config + HubSpot → CRM
Separate CRM `ObjectSpec`s · disjoint `SPEC_BY_BOARD` · ownership hook in the shared engine with tests · crons OFF · `DRY_RUN=true`, then `dryRun=false, writeHubspot=false` for controlled validation · **no stamping yet**.

### Phase 2 — prerequisites + scoped two-way
Create HubSpot `sync_owner` properties · add both Workers' guards + fetch-list entries · clean/protect demo rows · configure the CRM create cutoff · stamp a tiny test set · enable two-way for that set only · verify the old Worker refuses them · verify WM mirrors stay read-only.

### Phase 3 — production cutover
Approval gate · deploy old-Worker guard · old `createFromMonday=false` · approve `CRM_CUTOVER_AT` · enable CRM ownership + reverse writes · old WM stays two-way for WM-owned records · optionally enable the 10-minute drift net · full sweep stays OFF.

---

## 24. Opening prompt

> Read `docs/handoff/2026-09-07-monday-crm-sync-handoff.md` in full before doing anything. Treat it as the authoritative architecture and safety specification for Phase 1.
>
> We are building HubSpot ↔ monday CRM two-way sync for **Contacts and Companies/Accounts only**, using monday CRM boards `5028000495` (Contacts) and `5028000496` (Accounts). There is **no historical import** — new records only, going forward.
>
> The existing HubSpot ↔ monday Work Management sync is live in production and must keep working. Reuse the shared sync engine; do not fork or restructure it into separate legacy/CRM engines. Add CRM support through separate `ObjectSpec` configuration plus only the small shared engine changes the ownership model explicitly requires.
>
> Start with Phase 0 discovery: graphify first, inspect the production Contact/Company specs and every HubSpot mutation path, inspect both CRM boards through the monday API, inspect the HubSpot Contact/Company schemas, then produce the board-cleanup and field-mapping proposals. Do not write sync code before those proposals are reviewed.
>
> The critical architecture is **per-record HubSpot write ownership** via `sync_owner = wm | crm`, with `CRM_CUTOVER_AT` only as a fallback for unstamped records. Ownership claiming must use a dedicated `canClaimCrmOwnership()` path whose **only** permitted HubSpot mutation is a single-property `sync_owner=crm` PATCH — normal writes still require `sync_owner=="crm"`. Always fetch `sync_owner` and `createdate` as ownership metadata regardless of the mapped field list, and do not expose `sync_owner` as a monday column. No claiming while `writeHubspot=false`.
>
> The old Worker stays two-way for WM-owned records. CRM-owned records may still have old Work Management mirror cards for Deal associations, but those mirrors must never write HubSpot.
>
> Use `singleGroup: "topics"` for both CRM specs initially (Contacts topics = Active Contacts; Accounts topics = Companies). The engine enforces `singleGroup` continuously, so do not treat "Inactive Contacts" as a working synchronized state — during Phase 0 rename it to show it is not synced, or remove it only if inspection confirms it is unused template data. Do not implement Active/Inactive mapping in Phase 1.
>
> Register monday item creation with the **`create_item`** webhook event even though delivered payloads may say `type=create_pulse`, and register both CRM boards against the new Worker. Use a second HubSpot app with its own signing secret, and reuse the existing HubSpot webhook parser, which already supports both generic and legacy subscription formats.
>
> Keep the existing CRM HubSpot-ID and Sync-State **text** columns unless API inspection proves otherwise. Prefer native monday CRM fields: native phone column (never numbers), People columns for owners/users, explicit enum mapping for HubSpot enums, and item names as display-only rather than reverse-parsed.
>
> Before enabling CRM→HubSpot creation, explicitly handle the 5 Contact + 3 Account demo rows and add a CRM-specific create cutoff so template/test rows can never create production HubSpot records.
>
> For Contacts, adopt an existing HubSpot Contact by normalized email before creating. For Companies, require a usable domain and adopt by domain before creating; never auto-create a Company without a domain, and never match Companies by name alone.
>
> Delete behaviour is fixed: HubSpot delete → delete the monday CRM item; monday delete → never delete HubSpot.
>
> Roll out in stages: dry run → real HubSpot→CRM with `dryRun=false, writeHubspot=false` → tiny `sync_owner=crm` two-way test scope → approved production cutover.
>
> Remember throughout: **two monday cards for the same HubSpot record are acceptable; two systems writing the same HubSpot record are not.**
>
> Do not deploy production changes, create HubSpot ownership properties, change the old Worker scope, disable old `createFromMonday`, or delete board columns/items without an explicit approval gate.
>
> Follow: brainstorm → spec → review → plan → review → implement. Never `npx tsc`. Do not push unless asked. No `Co-Authored-By: Claude` trailer.

---

## 25. Phase 1 success criteria

- New HubSpot Contacts appear in monday CRM Contacts; new CRM Contacts safely create **or adopt** HubSpot Contacts.
- New HubSpot Companies appear in monday CRM Accounts; new CRM Accounts safely create **or adopt** HubSpot Companies.
- Historical HubSpot Contacts/Companies are **not** imported.
- Existing CRM template/test rows cannot create junk HubSpot records.
- Two-way updates work **only** for the Worker that owns the HubSpot record.
- Old WM historical records remain two-way; CRM-owned records may have WM relation mirrors that are read-only toward HubSpot.
- HubSpot deletions delete the CRM item; monday deletions never delete HubSpot.
- Duplicate webhook delivery never duplicates records.
- Email/domain adoption prevents duplicate HubSpot creation.
- Phone, enums, owners, empty-value behaviour and Sync State all safe.
- The production Work Management system remains fully functional throughout.

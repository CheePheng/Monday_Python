# HubSpot ↔ monday.com API Proof of Concept

A small Python/Jupyter harness that proves we can drive the **monday.com** and **HubSpot** APIs
from Python for our internal sales-follow-up workflow — *before* building any webhook, Cloudflare
worker, or two-way sync.

**Why this exists:** HubSpot stays the CRM / source of truth. monday.com Work Management is used by
each salesperson to track follow-up (we are **not** using monday CRM). The native monday HubSpot
sync was rejected because it let multiple owners' deals land on one board and its two-way sync
**created duplicate HubSpot deals**. This POC proves Python can route deals to the **correct
per-owner board**, **never duplicate** a monday item, and **never create a HubSpot deal**.

> **Out of scope (deferred):** production webhooks, Cloudflare, full two-way sync, any HubSpot
> writes, monday CRM. Boards, groups, and columns are created manually in monday for now.

---

## What's in here

| File | Purpose |
|------|---------|
| `monday_smoke_test.py` / `.ipynb` | Prove the monday token works; read board groups/columns; create one test item |
| `hubspot_smoke_test.py` / `.ipynb` | Prove the HubSpot token works; list recent deals + owners |
| `owner_router_test.py` | Route deals → correct owner's board; create or update (dedup by HubSpot Deal ID); never duplicates |
| `tests/test_routing.py` | Unit + integration tests for the router's logic (run offline) |
| `config.example.json` | Owner→board map, monday column ids, HubSpot pipeline id |
| `.env.example` | Token + flag template |

---

## 1. Setup

```bash
# from this folder
cp .env.example .env
cp config.example.json config.json
pip install -r requirements.txt
```

Then open `.env` and `config.json` in your editor and fill in the blanks (next sections explain
where each value comes from). Both `.env` and `config.json` are git-ignored — your tokens and ids
are never committed.

### Get your tokens

- **`MONDAY_API_TOKEN`** — in monday: click your avatar (bottom-left) → **Developers** →
  **My Access Tokens** → copy the token. Paste it as-is (no "Bearer" prefix).
- **`HUBSPOT_ACCESS_TOKEN`** — in HubSpot: **Settings → Integrations → Private Apps** → create (or
  open) a private app → **Auth** tab → copy the access token. The app needs these scopes:
  `crm.objects.deals.read` and `crm.objects.owners.read`.

---

## 2. Run the smoke tests

You can run everything either as a notebook (Jupyter Lab) or as a plain script (VS Code terminal).
Both do the same thing.

### Option A — Jupyter Lab (notebooks)

```bash
jupyter lab
```

Then open `monday_smoke_test.ipynb` or `hubspot_smoke_test.ipynb` and **Run All Cells**. Each step
prints the raw JSON response plus a friendly summary line.

### Option B — VS Code terminal (scripts)

```bash
python monday_smoke_test.py
python hubspot_smoke_test.py
python owner_router_test.py
```

---

## 3. Finding the ids you need

The smoke tests are also your **id-discovery tools** — run them and copy the printed ids into
`config.json`.

- **monday board id** — open the board in your browser. The URL looks like
  `https://<account>.monday.com/boards/1234567890`. The number is the board id. Put it in `.env`
  as `TEST_BOARD_ID` (for the smoke test) and in `config.json` under each owner's
  `monday_board_id`.
- **monday group ids + column id** — run `python monday_smoke_test.py`. **Step 2** prints every
  group as `group <title> -> id <id>` and every column as `column <title> (<type>) -> id <id>`.
  You need: the **group id for each deal stage** (the "Sales Pipeline 01…08" groups) and the id of
  the **HubSpot Deal ID** column (the dedup key; Text or Numbers both work).
- **HubSpot pipeline id + stage ids + owner ids** — the pipeline + stage ids come from the HubSpot
  pipelines API (`GET /crm/v3/pipelines/deals`); owner ids come from `python hubspot_smoke_test.py`
  (`owner <id> | <name> | <email>`). The default sales pipeline has id `default` and stage ids like
  `appointmentscheduled`, `qualifiedtobuy`, `closedwon`, etc.

### Routing model (board = owner, group = stage)

Each salesperson has **one board**; the board's **groups are the deal stages**. The router puts a
deal on its owner's board, in the **group matching the deal's HubSpot stage**.

**Onboarding a salesperson is just their board id + email:**

```json
"Myla Mestiola": {
  "email": "mylamestiola@dkmeco.com",
  "monday_board_id": "5029496327"
}
```

- **Owner** is resolved by **email** (the script looks the email up in HubSpot's owner list to get
  the owner id). You can also pin an explicit `"hubspot_owner_id"`; matching order is id → email → name.
- **Stage → group** is **auto-detected**: the router reads the board's group titles and the
  pipeline's stage labels and maps `Qualified To Buy` → `Sales Pipeline 02 - Qualified To Buy`, etc.
  (You can override with an explicit `"stage_to_group"` map if a board doesn't follow that naming.)

### Field mapping (every monday column gets filled)

A `field_map` in config maps **HubSpot deal property → monday column id**, and the router formats
each value for that column's type automatically (fetched from the board):

| monday column type | written as | example |
|---|---|---|
| status (Deal Stage) | `{"label": "..."}` | HubSpot stage → `Appointment Scheduled` |
| dropdown (Pipeline/Deal Type/Priority/Vendors) | `{"labels": ["..."]}` | `existingbusiness` → `Existing Business` |
| people (Deal Owner) | `{"personsAndTeams": [...]}` | owner email → matching monday user |
| date (Date Created) | `{"date": "YYYY-MM-DD"}` | from `createdate` |
| numbers (HubSpot Deal ID) | `"123..."` | the dedup key |
| link (HubSpot Link) | `{"url": ..., "text": ...}` | deep link to the deal |

The **item name** is set to the deal name (and updated on every sync). `create_labels_if_missing`
is on, so new dropdown/status values won't error. Dedup scans the **whole board**, so a deal that
changes stage **updates in place** instead of duplicating. A deal whose owner or stage isn't mapped
is **skipped and logged**. Properties with no matching monday column (e.g. Amount, Close Date if the
board lacks those columns) are simply ignored — add the columns and map them to sync them.

---

## 4. Testing safely with DRY_RUN

`DRY_RUN` (in `.env`) defaults to **`True`**, which means **nothing is written to monday**:

- `monday_smoke_test.py` prints the create-item payload it *would* send, instead of creating it.
- `owner_router_test.py` prints the create/update payloads it *would* send for each deal.

When you've reviewed the output and want to actually write, set `DRY_RUN=False` in `.env` and re-run.
The smoke test will then create a clearly-labeled `API TEST - monday item`; the router will create
or update real items.

**HubSpot is always read-only** — no flag can make this code create or modify a HubSpot deal.

### Auto-sync with the watcher (no manual runs)

Instead of running the sync by hand, leave the watcher running in a terminal. Each tick it asks
HubSpot only for deals **modified since the last check** (cheap) and syncs just those; the heavy
setup is loaded once at startup.

```bash
python watch.py                 # DRY preview loop (no writes) — safe to watch first
python watch.py --live          # actually write to monday
python watch.py --live --interval 30   # change the poll interval (default 10s)
```

`--live` forces writes for the watcher only; a plain `python owner_router_test.py` still respects
`.env` (stays a dry preview). Stop the watcher with Ctrl+C. It only runs while the terminal/PC is on;
for always-on, real-time sync see the deferred Cloudflare webhook plan.

### Two-way sync (monday ↔ HubSpot)

`sync.py` reconciles **both directions** with **last-edit-wins**, and is **update-only** (it never
creates a HubSpot deal). For each deal on both sides (matched by HubSpot Deal ID) it compares the
editable fields; if they differ, the side whose record changed more recently wins. Because it only
acts when values differ, it can't ping-pong.

```bash
python sync.py                          # preview BOTH directions, write nothing (safe)
python sync.py --live                   # allow monday writes (HubSpot side still preview)
python sync.py --live --write-hubspot   # allow both directions to write
```

- **Reversible fields:** deal name, stage (via group), Deal Type, Priority, Vendor. Owner, Pipeline,
  Created date, HubSpot Deal ID and HubSpot Link stay one-way / read-only.
- **Use `sync.py` instead of `watch.py` for two-way.** `watch.py` is one-way (HubSpot→monday) and
  will keep reverting monday edits; `sync.py` is the reconciler that respects both sides.
- **Reverse writes need a HubSpot scope.** Add **`crm.objects.deals.write`** to your private app
  (Scopes tab) — the read-only token returns `403` on write. Until then, `--write-hubspot` previews
  the PATCH but HubSpot rejects it.

### Run the automated tests

The router's logic (owner matching, duplicate detection, payload building, routing decisions) is
covered by tests that run **offline** (no tokens needed):

```bash
python -m pytest tests/ -v
```

Expected: **12 passed**. The key guarantees are proven by
`test_existing_deal_is_updated_not_duplicated` (re-running never duplicates, even across stage
changes), `test_new_deal_is_created_in_its_stage_group` (stage→group routing), and
`test_unmapped_owner_is_skipped` (boards stay owner-pure).

---

## 5. What success looks like

| # | Goal | How you confirm it |
|---|------|--------------------|
| 1 | monday token works | `monday_smoke_test.py` Step 1 prints your account `id / name / email` |
| 2 | Read board groups & columns | Step 2 lists every group and column with its id |
| 3 | Create a monday item | With `DRY_RUN=False`, an `API TEST - monday item` appears in a board group |
| 4 | HubSpot token works | `hubspot_smoke_test.py` Step 1 returns recent deals |
| 5 | Read deals & owners | Step 1 prints deal id/name/owner/stage/amount/close; Step 2 prints owners |
| 6 | Route deals by owner + stage | `owner_router_test.py` sends each deal to its owner's board, into the group matching its stage, and logs `skipping` for unmapped owners/stages |
| 7 | No duplicates, no HubSpot deals created | Re-running the router **updates** existing items instead of creating new ones, and it makes zero HubSpot write calls |

---

## Typical first run

```bash
cp .env.example .env            # fill MONDAY_API_TOKEN, TEST_BOARD_ID, HUBSPOT_ACCESS_TOKEN
cp config.example.json config.json
pip install -r requirements.txt

python -m pytest tests/ -v      # 11 passed, offline
python monday_smoke_test.py     # copy the group + column ids it prints into config.json
python hubspot_smoke_test.py    # copy the pipeline id + owner ids into config.json
python owner_router_test.py     # DRY_RUN=True: review the routing decisions it would make
```

When the dry-run output looks right, set `DRY_RUN=False` and run the router again to write to monday.

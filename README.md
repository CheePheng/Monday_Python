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
- **monday group id + column ids** — run `python monday_smoke_test.py`. **Step 2** prints every
  group as `group <title> -> id <id>` and every column as `column <title> (<type>) -> id <id>`.
  Copy the column ids into `config.json` → `monday_columns`. You need a column to store the
  **HubSpot Deal ID** (this is the dedup key); a plain **Text** column works.
- **HubSpot pipeline id + owner ids** — run `python hubspot_smoke_test.py`. It prints each deal's
  `pipeline` (in the raw JSON) and each owner as `owner <id> | <name> | <email>`. Put the sales
  pipeline id in `config.json` → `hubspot_pipeline_id`, and (optionally) each salesperson's owner
  id under their entry as `hubspot_owner_id`.

### Column-type note

The router writes column values as **text** for every field except `amount`. Configure the mapped
monday columns as **Text** columns (and `amount` as a **Numbers** column — monday accepts the
numeric value as a string). Owner matching works by `hubspot_owner_id` **or** by the owner's full
name (the key in `config.json` → `owners`); id is matched first, then name.

---

## 4. Testing safely with DRY_RUN

`DRY_RUN` (in `.env`) defaults to **`True`**, which means **nothing is written to monday**:

- `monday_smoke_test.py` prints the create-item payload it *would* send, instead of creating it.
- `owner_router_test.py` prints the create/update payloads it *would* send for each deal.

When you've reviewed the output and want to actually write, set `DRY_RUN=False` in `.env` and re-run.
The smoke test will then create a clearly-labeled `API TEST - monday item`; the router will create
or update real items.

**HubSpot is always read-only** — no flag can make this code create or modify a HubSpot deal.

### Run the automated tests

The router's logic (owner matching, duplicate detection, payload building, routing decisions) is
covered by tests that run **offline** (no tokens needed):

```bash
python -m pytest tests/ -v
```

Expected: **11 passed**. The key guarantees are proven by
`test_existing_deal_is_updated_not_duplicated` (re-running never duplicates) and
`test_unmapped_owner_is_skipped` (boards stay owner-pure).

---

## 5. What success looks like

| # | Goal | How you confirm it |
|---|------|--------------------|
| 1 | monday token works | `monday_smoke_test.py` Step 1 prints your account `id / name / email` |
| 2 | Read board groups & columns | Step 2 lists every group and column with its id |
| 3 | Create a monday item | With `DRY_RUN=False`, an `API TEST - monday item` appears in the "Sales Pipeline" group |
| 4 | HubSpot token works | `hubspot_smoke_test.py` Step 1 returns recent deals |
| 5 | Read deals & owners | Step 1 prints deal id/name/owner/stage/amount/close; Step 2 prints owners |
| 6 | Route deals by owner | `owner_router_test.py` sends each deal to its owner's board and logs `skipping` for unmapped owners |
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

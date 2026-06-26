import os
import sys
import json
from dotenv import load_dotenv
import requests

load_dotenv()
# os.getenv (not os.environ[...]) so the module imports without creds — pytest needs this.
MONDAY_TOKEN = os.getenv("MONDAY_API_TOKEN")
HUBSPOT_TOKEN = os.getenv("HUBSPOT_ACCESS_TOKEN")
DRY_RUN = os.getenv("DRY_RUN", "True").lower() != "false"
CONFIG_PATH = os.getenv("CONFIG_PATH", "config.json")
MONDAY_URL = "https://api.monday.com/v2"
HUBSPOT_BASE = "https://api.hubapi.com"


# ---------------- pure logic (unit-tested) ----------------

def parse_deal(raw):
    p = raw.get("properties", {})
    return {
        "id": str(raw["id"]),
        "name": p.get("dealname"),
        "owner_id": p.get("hubspot_owner_id"),
        "stage": p.get("dealstage"),
        "amount": p.get("amount"),
        "close_date": p.get("closedate"),
    }


def match_owner_config(owner_id, owner_name, owner_email, config):
    """Find the config entry for a deal's owner. Match priority: explicit
    hubspot_owner_id, then email, then the entry key as a display name."""
    owners = config.get("owners", {})
    for key, entry in owners.items():
        if owner_id and entry.get("hubspot_owner_id") == owner_id:
            return key, entry
    for key, entry in owners.items():
        if owner_email and entry.get("email", "").lower() == owner_email.lower():
            return key, entry
    for key, entry in owners.items():
        if owner_name and key == owner_name:
            return key, entry
    return None


def build_stage_to_group(groups, stages):
    """Auto-map HubSpot stage id -> monday group id by matching the stage's label
    to the group whose title contains it (e.g. 'Qualified To Buy' sits inside
    'Sales Pipeline 02 - Qualified To Buy'). Stages with no matching group are omitted."""
    mapping = {}
    for stage_id, label in stages.items():
        if not label:
            continue
        for g in groups:
            if label in (g.get("title") or ""):
                mapping[str(stage_id)] = g["id"]
                break
    return mapping


def find_existing_item(items, deal_id_col, hubspot_deal_id):
    for item in items:
        for cv in item.get("column_values", []):
            if cv.get("id") == deal_id_col and (cv.get("text") or "") == str(hubspot_deal_id):
                return item
    return None


def format_column_value(field, col_type, value, ctx):
    """Shape one HubSpot field value for a monday column of col_type.
    Returns the column_values value, or None to skip. ctx carries the lookup
    maps (stages, dropdown option labels, pipeline label, owner->monday user)."""
    if value in (None, ""):
        return None
    if col_type == "people":
        email = ((ctx["owners_by_id"].get(str(value), {}) or {}).get("email") or "").lower()
        muser = ctx["email_to_muser"].get(email)
        return {"personsAndTeams": [{"id": int(muser), "kind": "person"}]} if muser else None
    if col_type == "status":
        label = ctx["stages"].get(value, value) if field == "dealstage" else value
        return {"label": label}
    if col_type == "dropdown":
        if field == "pipeline":
            label = ctx.get("pipeline_label", value)
        elif field == "dealtype":
            label = ctx.get("dealtype_labels", {}).get(value, value)
        elif field == "hs_priority":
            label = ctx.get("priority_labels", {}).get(value, value)
        else:
            label = value
        return {"labels": [x for x in str(label).split(";") if x]}
    if col_type == "date":
        return {"date": str(value)[:10]}
    if col_type == "numbers":
        return str(value)
    return str(value)


def build_column_values(props, deal_id, columns_meta, field_map, deal_id_col, ctx):
    """Full monday column_values for a deal, each value formatted for its column type."""
    cv = {}
    if deal_id_col:
        cv[deal_id_col] = str(deal_id)
    for field, col in field_map.items():
        res = format_column_value(field, columns_meta.get(col), props.get(field), ctx)
        if res is not None:
            cv[col] = res
    link_col, portal = ctx.get("link_col"), ctx.get("portal_id")
    if link_col and portal and columns_meta.get(link_col) == "link":
        cv[link_col] = {"url": f"https://app.hubspot.com/contacts/{portal}/record/0-3/{deal_id}",
                        "text": "Open in HubSpot"}
    return cv


def configured_owner_ids(config, owners_by_id):
    """Resolve the HubSpot owner ids for every owner mapped in config.
    Priority per entry: explicit hubspot_owner_id, then email, then the key as a name."""
    name_to_id = {v["name"]: oid for oid, v in owners_by_id.items() if v.get("name")}
    email_to_id = {v["email"].lower(): oid for oid, v in owners_by_id.items() if v.get("email")}
    ids = set()
    for key, entry in config.get("owners", {}).items():
        oid = entry.get("hubspot_owner_id")
        if not oid and entry.get("email"):
            oid = email_to_id.get(entry["email"].lower())
        if not oid:
            oid = name_to_id.get(key)
        if oid:
            ids.add(str(oid))
    return sorted(ids)


def deal_properties(field_map):
    """The HubSpot properties to fetch: the mapped fields plus the basics."""
    return sorted({"dealname", "createdate", "hubspot_owner_id", "dealstage"} | set(field_map))


# ---------------- HTTP helpers ----------------

def load_config(path=None):
    with open(path or CONFIG_PATH) as f:
        return json.load(f)


def monday_query(query, variables=None):
    headers = {"Authorization": MONDAY_TOKEN, "Content-Type": "application/json",
               "API-Version": "2024-10"}
    data = requests.post(MONDAY_URL, json={"query": query, "variables": variables or {}},
                         headers=headers, timeout=30).json()
    if "errors" in data:
        raise RuntimeError(data["errors"])
    return data["data"]


def hubspot(method, path, **kw):
    headers = {"Authorization": f"Bearer {HUBSPOT_TOKEN}", "Content-Type": "application/json"}
    resp = requests.request(method, HUBSPOT_BASE + path, headers=headers, timeout=30, **kw)
    resp.raise_for_status()
    return resp.json()


# ---------------- HubSpot reads (read-only) ----------------

def fetch_deals(pipeline_id, owner_ids, properties):
    """Every deal in the pipeline for the given owners, paged through fully."""
    filters = [{"propertyName": "pipeline", "operator": "EQ", "value": pipeline_id}]
    if owner_ids:
        filters.append({"propertyName": "hubspot_owner_id", "operator": "IN",
                        "values": list(owner_ids)})
    results, after = [], None
    while True:
        body = {"filterGroups": [{"filters": filters}],
                "sorts": [{"propertyName": "createdate", "direction": "DESCENDING"}],
                "properties": properties, "limit": 100}
        if after:
            body["after"] = after
        page = hubspot("POST", "/crm/v3/objects/deals/search", json=body)
        results.extend(page.get("results", []))
        after = page.get("paging", {}).get("next", {}).get("after")
        if not after:
            return results


def fetch_owners():
    results = hubspot("GET", "/crm/v3/owners/", params={"limit": 100})["results"]
    return {str(o["id"]): {
        "name": f"{o.get('firstName', '')} {o.get('lastName', '')}".strip(),
        "email": o.get("email")} for o in results}


def fetch_pipeline(pipeline_id):
    """(stage_id -> label, pipeline_label) for the given deal pipeline."""
    for p in hubspot("GET", "/crm/v3/pipelines/deals").get("results", []):
        if p["id"] == pipeline_id:
            return {s["id"]: s["label"] for s in p.get("stages", [])}, p.get("label", "")
    return {}, ""


def fetch_property_options(prop):
    """{internal value -> label} for a HubSpot enumeration property."""
    p = hubspot("GET", f"/crm/v3/properties/deals/{prop}")
    return {o["value"]: o["label"] for o in p.get("options", [])}


def fetch_portal_id():
    try:
        return hubspot("GET", "/account-info/v3/details").get("portalId")
    except Exception:
        return None


# ---------------- monday reads ----------------

def fetch_monday_users():
    users = monday_query("query { users(limit:500) { id email } }")["users"]
    return {u["email"].lower(): u["id"] for u in users if u.get("email")}


def get_board_groups(board_id):
    q = "query ($b:[ID!]) { boards(ids:$b) { groups { id title } } }"
    boards = monday_query(q, {"b": [str(board_id)]})["boards"]
    return boards[0]["groups"] if boards else []


def get_board_columns(board_id):
    q = "query ($b:[ID!]) { boards(ids:$b) { columns { id type } } }"
    boards = monday_query(q, {"b": [str(board_id)]})["boards"]
    return {c["id"]: c["type"] for c in boards[0]["columns"]} if boards else {}


def get_board_items(board_id):
    """All items on the board (across every group) with their column values.
    We dedup against the WHOLE board so a deal that changed stage updates in place."""
    q = ("query ($b:[ID!]) { boards(ids:$b) { items_page(limit:500) { items { "
         "id name updated_at group { id } column_values { id text } } } } }")
    boards = monday_query(q, {"b": [str(board_id)]})["boards"]
    return boards[0]["items_page"]["items"] if boards else []


# ---------------- monday writes (honor DRY_RUN) ----------------

def create_item(board_id, group_id, name, column_values):
    if DRY_RUN:
        print(f"  DRY_RUN: would CREATE '{name}' in {board_id}/{group_id} cols={column_values}")
        return None
    q = ("mutation ($b:ID!, $g:String!, $n:String!, $c:JSON) { create_item(board_id:$b, "
         "group_id:$g, item_name:$n, column_values:$c, create_labels_if_missing:true){id} }")
    new_id = monday_query(q, {"b": str(board_id), "g": group_id, "n": name,
                              "c": json.dumps(column_values)})["create_item"]["id"]
    print(f"  CREATED monday item {new_id}")
    return new_id


def update_item(board_id, item_id, name, column_values):
    cols = dict(column_values)
    if name:
        cols["name"] = name  # monday updates the item name via the "name" column id
    if DRY_RUN:
        print(f"  DRY_RUN: would UPDATE item {item_id} cols={cols}")
        return
    q = ("mutation ($b:ID!, $i:ID!, $c:JSON!) { change_multiple_column_values(board_id:$b, "
         "item_id:$i, column_values:$c, create_labels_if_missing:true){id} }")
    monday_query(q, {"b": str(board_id), "i": str(item_id), "c": json.dumps(cols)})
    print(f"  UPDATED monday item {item_id}")


# ---------------- orchestration ----------------

def route_deals(config, raw_deals, ctx):
    field_map, deal_id_col = ctx["field_map"], ctx["deal_id_col"]
    owners_by_id = ctx["owners_by_id"]
    stats = {"processed": 0, "created": 0, "updated": 0, "skipped": 0}
    for raw in raw_deals:
        stats["processed"] += 1
        deal = parse_deal(raw)
        props = raw.get("properties", {})
        oinfo = owners_by_id.get(str(deal["owner_id"]), {}) or {}
        match = match_owner_config(deal["owner_id"], oinfo.get("name"), oinfo.get("email"), config)
        if not match:
            print(f"deal {deal['id']} ({deal['name']}): no board mapped for owner "
                  f"{oinfo.get('name') or deal['owner_id']} — skipping")
            stats["skipped"] += 1
            continue
        owner_key, entry = match
        board_id = entry["monday_board_id"]
        group_id = entry.get("stage_to_group", {}).get(str(deal["stage"]))
        if not group_id:
            print(f"deal {deal['id']} ({deal['name']}): stage '{deal['stage']}' not mapped to a "
                  f"group on {owner_key}'s board — skipping")
            stats["skipped"] += 1
            continue
        columns_meta = ctx["board_columns"].get(board_id, {})
        cv = build_column_values(props, deal["id"], columns_meta, field_map, deal_id_col, ctx)
        name = deal["name"] or f"Deal {deal['id']}"
        existing = find_existing_item(get_board_items(board_id), deal_id_col, deal["id"])
        print(f"deal {deal['id']} ({name}) -> {owner_key} / board {board_id} / group {group_id}")
        if existing:
            update_item(board_id, existing["id"], name, cv)
            stats["updated"] += 1
        else:
            create_item(board_id, group_id, name, cv)
            stats["created"] += 1
    return stats


def build_context(config):
    """One-time lookups shared across all deals: owners, monday users, pipeline
    stages/label, dropdown option labels, portal id, and per-board column types +
    auto stage->group maps."""
    pipeline_id = config["hubspot_pipeline_id"]
    owners_by_id = fetch_owners()
    stages, pipeline_label = fetch_pipeline(pipeline_id)
    ctx = {
        "owners_by_id": owners_by_id,
        "email_to_muser": fetch_monday_users(),
        "stages": stages,
        "pipeline_label": pipeline_label,
        "dealtype_labels": fetch_property_options("dealtype"),
        "priority_labels": fetch_property_options("hs_priority"),
        "portal_id": fetch_portal_id(),
        "field_map": config.get("field_map", {}),
        "deal_id_col": config.get("monday_columns", {}).get("hubspot_deal_id"),
        "link_col": config.get("monday_columns", {}).get("hubspot_link"),
        "board_columns": {},
    }
    for key, entry in config["owners"].items():
        board_id = entry["monday_board_id"]
        ctx["board_columns"].setdefault(board_id, get_board_columns(board_id))
        if not entry.get("stage_to_group"):
            entry["stage_to_group"] = build_stage_to_group(get_board_groups(board_id), stages)
            print(f"auto-mapped {len(entry['stage_to_group'])} stages -> groups for {key}")
    return ctx, owners_by_id, pipeline_id


def main():
    if not MONDAY_TOKEN or not HUBSPOT_TOKEN:
        raise SystemExit("Set MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN in .env first.")
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # so non-ASCII deal names print on Windows
    except Exception:
        pass
    print(f"DRY_RUN={DRY_RUN}")
    config = load_config()
    ctx, owners_by_id, pipeline_id = build_context(config)
    owner_ids = configured_owner_ids(config, owners_by_id)
    raw_deals = fetch_deals(pipeline_id, owner_ids, deal_properties(ctx["field_map"]))
    print(f"fetched {len(raw_deals)} deals from pipeline {pipeline_id} for mapped owners {owner_ids}")
    stats = route_deals(config, raw_deals, ctx)
    print(f"SUMMARY: {stats}")


if __name__ == "__main__":
    main()

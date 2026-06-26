import os
import json
from dotenv import load_dotenv
import requests

load_dotenv()
# os.getenv (not os.environ[...]) so the module imports without creds — pytest needs this.
MONDAY_TOKEN = os.getenv("MONDAY_API_TOKEN")
HUBSPOT_TOKEN = os.getenv("HUBSPOT_ACCESS_TOKEN")
DRY_RUN = os.getenv("DRY_RUN", "True").lower() != "false"
LIMIT = int(os.getenv("HUBSPOT_DEALS_LIMIT", "10"))
CONFIG_PATH = os.getenv("CONFIG_PATH", "config.json")
MONDAY_URL = "https://api.monday.com/v2"
HUBSPOT_BASE = "https://api.hubapi.com"


# --- pure logic (unit-tested) ---

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


def build_column_values(deal, owner_name, columns):
    field_map = {
        "hubspot_deal_id": deal.get("id"),
        "deal_name": deal.get("name"),
        "deal_owner": owner_name,
        "deal_stage": deal.get("stage"),
        "amount": deal.get("amount"),
    }
    out = {}
    for field, col_id in columns.items():
        if not col_id or str(col_id).startswith("PUT_"):
            continue
        value = field_map.get(field)
        if value is None:
            continue
        out[col_id] = str(value)
    return out


# --- config + network I/O ---

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


def fetch_deals(pipeline_id, owner_ids=None):
    """Every deal in the pipeline, optionally restricted to specific owner ids.
    Pages through all results (100 per page) so we don't miss older deals."""
    filters = [{"propertyName": "pipeline", "operator": "EQ", "value": pipeline_id}]
    if owner_ids:
        filters.append({"propertyName": "hubspot_owner_id",
                        "operator": "IN", "values": list(owner_ids)})
    results, after = [], None
    while True:
        body = {
            "filterGroups": [{"filters": filters}],
            "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "DESCENDING"}],
            "properties": ["dealname", "amount", "closedate", "dealstage",
                           "hubspot_owner_id", "pipeline"],
            "limit": 100,
        }
        if after:
            body["after"] = after
        page = hubspot("POST", "/crm/v3/objects/deals/search", json=body)
        results.extend(page.get("results", []))
        after = page.get("paging", {}).get("next", {}).get("after")
        if not after:
            return results


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


def fetch_owners():
    results = hubspot("GET", "/crm/v3/owners/", params={"limit": 100})["results"]
    return {str(o["id"]): {
        "name": f"{o.get('firstName', '')} {o.get('lastName', '')}".strip(),
        "email": o.get("email")} for o in results}


def fetch_pipeline_stages(pipeline_id):
    """{stage_id: label} for the given deal pipeline (used to auto-map stages to groups)."""
    data = hubspot("GET", "/crm/v3/pipelines/deals")
    for p in data.get("results", []):
        if p["id"] == pipeline_id:
            return {s["id"]: s["label"] for s in p.get("stages", [])}
    return {}


def get_board_groups(board_id):
    q = "query ($b:[ID!]) { boards(ids:$b) { groups { id title } } }"
    boards = monday_query(q, {"b": [str(board_id)]})["boards"]
    return boards[0]["groups"] if boards else []


def get_board_items(board_id):
    """All items on the board (across every group) with their group + column values.
    We dedup against the WHOLE board so a deal that changed stage updates in place
    instead of creating a second card. (limit 500 is plenty for the POC.)"""
    q = ("query ($b:[ID!]) { boards(ids:$b) { items_page(limit:500) { items { "
         "id name group { id } column_values { id text } } } } }")
    boards = monday_query(q, {"b": [str(board_id)]})["boards"]
    return boards[0]["items_page"]["items"] if boards else []


def create_item(board_id, group_id, name, column_values):
    if DRY_RUN:
        print(f"  DRY_RUN: would CREATE '{name}' in {board_id}/{group_id} cols={column_values}")
        return None
    q = ("mutation ($b:ID!, $g:String!, $n:String!, $c:JSON) { "
         "create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c) { id } }")
    new_id = monday_query(q, {"b": str(board_id), "g": group_id, "n": name,
                              "c": json.dumps(column_values)})["create_item"]["id"]
    print(f"  CREATED monday item {new_id}")
    return new_id


def update_item(board_id, item_id, column_values):
    if DRY_RUN:
        print(f"  DRY_RUN: would UPDATE item {item_id} cols={column_values}")
        return
    q = ("mutation ($b:ID!, $i:ID!, $c:JSON!) { "
         "change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }")
    monday_query(q, {"b": str(board_id), "i": str(item_id), "c": json.dumps(column_values)})
    print(f"  UPDATED monday item {item_id}")


# --- orchestration ---

def route_deals(config, owners_by_id, raw_deals):
    cols = config["monday_columns"]
    deal_id_col = cols.get("hubspot_deal_id")
    stats = {"processed": 0, "created": 0, "updated": 0, "skipped": 0}
    for raw in raw_deals:
        stats["processed"] += 1
        deal = parse_deal(raw)
        owner_info = owners_by_id.get(str(deal["owner_id"]), {}) or {}
        owner_name, owner_email = owner_info.get("name"), owner_info.get("email")
        match = match_owner_config(deal["owner_id"], owner_name, owner_email, config)
        if not match:
            print(f"deal {deal['id']} ({deal['name']}): no board mapped for owner "
                  f"{owner_name or deal['owner_id']} — skipping")
            stats["skipped"] += 1
            continue
        owner_key, entry = match
        board_id = entry["monday_board_id"]
        stage = str(deal["stage"])
        group_id = entry.get("stage_to_group", {}).get(stage)
        if not group_id:
            print(f"deal {deal['id']} ({deal['name']}): stage '{stage}' not mapped to a "
                  f"group on {owner_key}'s board — skipping")
            stats["skipped"] += 1
            continue
        items = get_board_items(board_id)
        existing = find_existing_item(items, deal_id_col, deal["id"])
        cv = build_column_values(deal, owner_key, cols)
        print(f"deal {deal['id']} ({deal['name']}) -> {owner_key} / board {board_id} / "
              f"group {group_id}")
        if existing:
            update_item(board_id, existing["id"], cv)
            stats["updated"] += 1
        else:
            create_item(board_id, group_id, deal["name"] or f"Deal {deal['id']}", cv)
            stats["created"] += 1
    return stats


def main():
    if not MONDAY_TOKEN or not HUBSPOT_TOKEN:
        raise SystemExit("Set MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN in .env first.")
    print(f"DRY_RUN={DRY_RUN}")
    config = load_config()
    owners_by_id = fetch_owners()
    pipeline_id = config["hubspot_pipeline_id"]

    # Auto-build each owner's stage->group map from their board, unless one is set explicitly.
    stages = fetch_pipeline_stages(pipeline_id)
    for key, entry in config["owners"].items():
        if not entry.get("stage_to_group"):
            groups = get_board_groups(entry["monday_board_id"])
            entry["stage_to_group"] = build_stage_to_group(groups, stages)
            print(f"auto-mapped {len(entry['stage_to_group'])} stages -> groups for {key}")

    owner_ids = configured_owner_ids(config, owners_by_id)
    raw_deals = fetch_deals(pipeline_id, owner_ids)
    print(f"fetched {len(raw_deals)} deals from pipeline {pipeline_id} "
          f"for mapped owners {owner_ids}")
    stats = route_deals(config, owners_by_id, raw_deals)
    print(f"SUMMARY: {stats}")


if __name__ == "__main__":
    main()

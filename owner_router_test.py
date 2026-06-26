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


def match_owner_config(owner_id, owner_name, config):
    for key, entry in config.get("owners", {}).items():
        if owner_id and entry.get("hubspot_owner_id") == owner_id:
            return key, entry
    for key, entry in config.get("owners", {}).items():
        if owner_name and key == owner_name:
            return key, entry
    return None


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


def fetch_recent_deals(pipeline_id):
    body = {
        "filterGroups": [{"filters": [
            {"propertyName": "pipeline", "operator": "EQ", "value": pipeline_id}]}],
        "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "DESCENDING"}],
        "properties": ["dealname", "amount", "closedate", "dealstage", "hubspot_owner_id", "pipeline"],
        "limit": LIMIT,
    }
    return hubspot("POST", "/crm/v3/objects/deals/search", json=body)["results"]


def fetch_owners():
    results = hubspot("GET", "/crm/v3/owners/", params={"limit": 100})["results"]
    return {str(o["id"]): {
        "name": f"{o.get('firstName', '')} {o.get('lastName', '')}".strip(),
        "email": o.get("email")} for o in results}


def get_group_id(board_id, group_title):
    q = "query ($b:[ID!]) { boards(ids:$b) { groups { id title } } }"
    for g in monday_query(q, {"b": [str(board_id)]})["boards"][0]["groups"]:
        if g["title"] == group_title:
            return g["id"]
    return None


def get_group_items(board_id, group_id):
    q = ("query ($b:[ID!], $g:[String]) { boards(ids:$b) { groups(ids:$g) { "
         "items_page(limit:500) { items { id name column_values { id text } } } } } }")
    groups = monday_query(q, {"b": [str(board_id)], "g": [group_id]})["boards"][0]["groups"]
    return groups[0]["items_page"]["items"] if groups else []


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
        owner_name = (owners_by_id.get(str(deal["owner_id"]), {}) or {}).get("name")
        match = match_owner_config(deal["owner_id"], owner_name, config)
        if not match:
            print(f"deal {deal['id']} ({deal['name']}): no board mapped for owner "
                  f"{owner_name or deal['owner_id']} — skipping")
            stats["skipped"] += 1
            continue
        owner_key, entry = match
        board_id, group_title = entry["monday_board_id"], entry["monday_group_title"]
        group_id = get_group_id(board_id, group_title)
        if not group_id:
            print(f"deal {deal['id']}: group '{group_title}' not on board {board_id} — skipping")
            stats["skipped"] += 1
            continue
        items = get_group_items(board_id, group_id)
        existing = find_existing_item(items, deal_id_col, deal["id"])
        cv = build_column_values(deal, owner_key, cols)
        print(f"deal {deal['id']} ({deal['name']}) -> {owner_key} / board {board_id}")
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
    raw_deals = fetch_recent_deals(config["hubspot_pipeline_id"])
    print(f"fetched {len(raw_deals)} deals from pipeline {config['hubspot_pipeline_id']}")
    stats = route_deals(config, owners_by_id, raw_deals)
    print(f"SUMMARY: {stats}")


if __name__ == "__main__":
    main()

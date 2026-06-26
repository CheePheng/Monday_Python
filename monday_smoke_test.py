import os
import json
from dotenv import load_dotenv
import requests

load_dotenv()
TOKEN = os.environ["MONDAY_API_TOKEN"]
BOARD_ID = os.environ["TEST_BOARD_ID"]
DRY_RUN = os.getenv("DRY_RUN", "True").lower() != "false"
API_URL = "https://api.monday.com/v2"
CONFIG_PATH = os.getenv("CONFIG_PATH", "config.json")


def monday_query(query, variables=None):
    headers = {
        "Authorization": TOKEN,
        "Content-Type": "application/json",
        "API-Version": "2024-10",
    }
    resp = requests.post(
        API_URL,
        json={"query": query, "variables": variables or {}},
        headers=headers,
        timeout=30,
    )
    data = resp.json()
    print(json.dumps(data, indent=2))  # raw JSON for debugging
    if "errors" in data:
        raise RuntimeError(data["errors"])
    return data["data"]


def load_optional_columns():
    """Return monday_columns from config.json if present and configured with a
    real hubspot_deal_id column id; otherwise None."""
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    cols = cfg.get("monday_columns", {})
    deal_col = cols.get("hubspot_deal_id")
    if not deal_col or str(deal_col).startswith("PUT_"):
        return None
    return cols


def main():
    print("=== STEP 1: AUTH (me) ===")
    me = monday_query("query { me { id name email } }")["me"]
    print(f"authenticated as id={me['id']} name={me['name']} email={me['email']}")

    print("\n=== STEP 2: READ BOARD GROUPS & COLUMNS ===")
    board_query = """
    query ($b:[ID!]) {
      boards(ids:$b) {
        id
        name
        groups { id title }
        columns { id title type }
      }
    }
    """
    board = monday_query(board_query, {"b": [BOARD_ID]})["boards"][0]
    print(f"board {board['id']} '{board['name']}'")
    for g in board["groups"]:
        print(f"  group {g['title']} -> id {g['id']}")
    for c in board["columns"]:
        print(f"  column {c['title']} ({c['type']}) -> id {c['id']}")

    print("\n=== STEP 3: FIND 'Sales Pipeline' GROUP ===")
    group = next((g for g in board["groups"] if g["title"] == "Sales Pipeline"), None)
    if group is None:
        print("WARNING: no 'Sales Pipeline' group found — skipping create")
        return
    print(f"found 'Sales Pipeline' group -> id {group['id']}")

    print("\n=== STEP 4: CREATE TEST ITEM ===")
    item_name = "API TEST - monday item"
    cols = load_optional_columns()
    column_values = None
    if cols:
        column_values = json.dumps({cols["hubspot_deal_id"]: "SMOKE-TEST"})
        print(f"will set column_values: {column_values}")

    create_query = """
    mutation ($b:ID!, $g:String!, $n:String!, $c:JSON) {
      create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c) { id }
    }
    """
    variables = {"b": BOARD_ID, "g": group["id"], "n": item_name, "c": column_values}
    if DRY_RUN:
        print("DRY_RUN: would create item with variables:")
        print(json.dumps(variables, indent=2))
        return
    created = monday_query(create_query, variables)["create_item"]
    print(f"created item id {created['id']}")


if __name__ == "__main__":
    main()

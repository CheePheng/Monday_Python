import os
import json
from dotenv import load_dotenv
import requests

load_dotenv()
TOKEN = os.environ["HUBSPOT_ACCESS_TOKEN"]
LIMIT = int(os.getenv("HUBSPOT_DEALS_LIMIT", "10"))
BASE = "https://api.hubapi.com"


def hubspot(method, path, **kw):
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    resp = requests.request(method, BASE + path, headers=headers, timeout=30, **kw)
    data = resp.json()
    print(json.dumps(data, indent=2))  # raw JSON for debugging
    resp.raise_for_status()
    return data


def main():
    print("=== STEP 1: RECENT DEALS ===")
    body = {
        "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "DESCENDING"}],
        "properties": [
            "dealname", "amount", "closedate", "dealstage", "hubspot_owner_id", "pipeline",
        ],
        "limit": LIMIT,
    }
    deals = hubspot("POST", "/crm/v3/objects/deals/search", json=body)["results"]
    print(f"\nfound {len(deals)} deals:")
    for d in deals:
        p = d.get("properties", {})
        print(
            f"  deal {d['id']} | {p.get('dealname')} | owner {p.get('hubspot_owner_id')} | "
            f"stage {p.get('dealstage')} | amount {p.get('amount')} | close {p.get('closedate')}"
        )

    print("\n=== STEP 2: OWNERS ===")
    owners = hubspot("GET", "/crm/v3/owners/", params={"limit": 100})["results"]
    print(f"\nfound {len(owners)} owners:")
    for o in owners:
        name = f"{o.get('firstName', '')} {o.get('lastName', '')}".strip()
        print(f"  owner {o['id']} | {name} | {o.get('email')}")


if __name__ == "__main__":
    main()

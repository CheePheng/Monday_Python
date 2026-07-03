"""Discovers the constants the Worker config needs. Run: python worker_discovery.py"""
import sys
import owner_router_test as r

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

print("=== deals.sales_user options ===")
p = r.hubspot("GET", "/crm/v3/properties/deals/sales_user")
for o in p.get("options", []):
    print(f"  value={o['value']!r} label={o['label']!r}")

print("\n=== sample deals that HAVE sales_user (see real values) ===")
body = {"filterGroups": [{"filters": [
            {"propertyName": "pipeline", "operator": "EQ", "value": "default"},
            {"propertyName": "sales_user", "operator": "HAS_PROPERTY"}]}],
        "properties": ["dealname", "sales_user", "hubspot_owner_id"], "limit": 10}
for d in r.hubspot("POST", "/crm/v3/objects/deals/search", json=body)["results"]:
    pr = d["properties"]
    print(f"  {d['id']} | {pr.get('dealname')} | sales_user={pr.get('sales_user')!r} | owner={pr.get('hubspot_owner_id')}")

for obj in ("contacts", "companies"):
    print(f"\n=== {obj}: routing/source/vendor-ish properties ===")
    for prop in r.hubspot("GET", f"/crm/v3/properties/{obj}")["results"]:
        n, l = prop["name"].lower(), prop.get("label") or ""
        if ("sales" in n and "user" in n) or "厂商" in l or "来源" in l or n in (
                "sales_user", "lead_source", "hs_lead_status", "industry", "type"):
            print(f"  {prop['name']} | {l} | {prop.get('fieldType')}")

print("\n=== contacts.hs_lead_status options (value -> label) ===")
p = r.hubspot("GET", "/crm/v3/properties/contacts/hs_lead_status")
for o in p.get("options", []):
    print(f"  value={o['value']!r} label={o['label']!r}")

print("\n=== counts for Myla (size the backfill) ===")
for obj in ("contacts", "companies"):
    body = {"filterGroups": [{"filters": [
        {"propertyName": "hubspot_owner_id", "operator": "EQ", "value": "1739141284"}]}],
        "properties": ["hs_object_id"], "limit": 1}
    res = r.hubspot("POST", f"/crm/v3/objects/{obj}/search", json=body)
    print(f"  {obj} owned by Myla: total={res.get('total')}")

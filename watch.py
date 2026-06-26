"""Continuously sync HubSpot -> monday.

Each tick asks HubSpot only for deals MODIFIED since the last check (cheap), then
routes just those. Heavy setup (owners, monday users, stage maps, board columns) is
loaded once at startup.

Usage:
    python watch.py                 # DRY preview loop (no writes) - safe to watch
    python watch.py --live          # actually write to monday
    python watch.py --live --interval 30
"""
import os
import sys
import time
import argparse
import datetime as dt

parser = argparse.ArgumentParser()
parser.add_argument("--interval", type=int, default=10, help="seconds between checks (default 10)")
parser.add_argument("--live", action="store_true", help="write to monday (default: dry preview)")
parser.add_argument("--since-minutes", type=int, default=5,
                    help="on startup, also catch deals modified in the last N minutes")
args = parser.parse_args()

# Decide write mode BEFORE importing the router (it reads DRY_RUN at import).
os.environ["DRY_RUN"] = "False" if args.live else "True"
import owner_router_test as r  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass


def fetch_modified_since(ts, owner_ids, pipeline_id, props):
    """Deals in the pipeline for these owners that changed at/after ts (UTC datetime)."""
    ms = int(ts.timestamp() * 1000)
    filters = [{"propertyName": "pipeline", "operator": "EQ", "value": pipeline_id},
               {"propertyName": "hs_lastmodifieddate", "operator": "GTE", "value": ms}]
    if owner_ids:
        filters.append({"propertyName": "hubspot_owner_id", "operator": "IN", "values": owner_ids})
    results, after = [], None
    while True:
        body = {"filterGroups": [{"filters": filters}],
                "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "ASCENDING"}],
                "properties": props, "limit": 100}
        if after:
            body["after"] = after
        page = r.hubspot("POST", "/crm/v3/objects/deals/search", json=body)
        results.extend(page.get("results", []))
        after = page.get("paging", {}).get("next", {}).get("after")
        if not after:
            return results


def main():
    if not r.MONDAY_TOKEN or not r.HUBSPOT_TOKEN:
        raise SystemExit("Set MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN in .env first.")
    config = r.load_config()
    print(f"LIVE={not r.DRY_RUN}  building context (one-time)...")
    ctx, owners_by_id, pipeline_id = r.build_context(config)
    owner_ids = r.configured_owner_ids(config, owners_by_id)
    props = r.deal_properties(ctx["field_map"])

    last_check = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=args.since_minutes)
    mode = "WRITING" if args.live else "DRY preview"
    print(f"[{mode}] watching pipeline {pipeline_id} for owners {owner_ids} "
          f"every {args.interval}s. Ctrl+C to stop.\n")

    while True:
        now = dt.datetime.now(dt.timezone.utc)
        try:
            changed = fetch_modified_since(last_check, owner_ids, pipeline_id, props)
            if changed:
                print(f"[{now:%H:%M:%S}] {len(changed)} changed deal(s):")
                stats = r.route_deals(config, changed, ctx)
                print(f"    {stats}")
            last_check = now
        except Exception as e:
            print(f"[{now:%H:%M:%S}] error: {e}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()

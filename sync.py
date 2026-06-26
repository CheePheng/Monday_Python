"""Two-way reconcile between HubSpot and monday (last-edit-wins, update-only).

For every deal that exists on both sides (matched by the HubSpot Deal ID stored on
the monday card), it compares the editable fields. If they differ, the side whose
record changed more recently wins:
  - HubSpot newer  -> push HubSpot values onto the monday card (forward)
  - monday newer   -> PATCH the HubSpot deal with the monday values (reverse)
Because it only acts when values DIFFER, it can't ping-pong. It NEVER creates a
HubSpot deal (update-only), and never touches read-only fields (Deal ID, HubSpot
Link, Created date).

Safety gates (default = preview EVERYTHING, write NOTHING):
    python sync.py                      # dry preview of both directions
    python sync.py --live               # allow monday writes (HubSpot still preview)
    python sync.py --live --write-hubspot   # allow BOTH directions to write

Reversible fields: deal name, stage (via group), Deal Type, Priority, Vendor.
Owner and Pipeline stay one-way (HubSpot -> monday) for now.
"""
import os
import sys
import argparse
import datetime as dt

parser = argparse.ArgumentParser()
parser.add_argument("--live", action="store_true", help="allow writes to monday")
parser.add_argument("--write-hubspot", action="store_true",
                    help="allow reverse writes (PATCH) to HubSpot deals")
args = parser.parse_args()

os.environ["DRY_RUN"] = "False" if args.live else "True"  # controls monday writes
import owner_router_test as r  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass

# HubSpot field -> ("reversible" reader). Read-only fields are intentionally absent.
REVERSIBLE = ["dealname", "dealstage", "dealtype", "hs_priority", "vendorschang_shang_lai_yuan"]


def parse_iso(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def col_text(item, col):
    for cv in item.get("column_values", []):
        if cv.get("id") == col:
            return (cv.get("text") or "").strip()
    return ""


def field_diffs(item, props, rev_group_to_stage, ctx):
    """List of {label, hs_prop, md} for fields where monday and HubSpot disagree.
    `md` is the value to write to HubSpot if monday wins."""
    fm = ctx["field_map"]
    out = []
    md_name = (item.get("name") or "").strip()
    if md_name != (props.get("dealname") or "").strip():
        out.append({"label": "name", "hs_prop": "dealname", "md": md_name})

    md_stage = rev_group_to_stage.get((item.get("group") or {}).get("id"))
    if md_stage and md_stage != (props.get("dealstage") or ""):
        out.append({"label": "stage", "hs_prop": "dealstage", "md": md_stage})

    if fm.get("dealtype"):
        lab = col_text(item, fm["dealtype"])
        val = ctx["dealtype_rev"].get(lab)
        if lab and val and val != (props.get("dealtype") or ""):
            out.append({"label": "dealtype", "hs_prop": "dealtype", "md": val})

    if fm.get("hs_priority"):
        lab = col_text(item, fm["hs_priority"])
        val = ctx["priority_rev"].get(lab)
        if lab and val and val != (props.get("hs_priority") or ""):
            out.append({"label": "priority", "hs_prop": "hs_priority", "md": val})

    if fm.get("vendorschang_shang_lai_yuan"):
        lab = col_text(item, fm["vendorschang_shang_lai_yuan"])
        if lab and lab != (props.get("vendorschang_shang_lai_yuan") or ""):
            out.append({"label": "vendor", "hs_prop": "vendorschang_shang_lai_yuan", "md": lab})
    return out


def main():
    if not r.MONDAY_TOKEN or not r.HUBSPOT_TOKEN:
        raise SystemExit("Set MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN in .env first.")
    config = r.load_config()
    print(f"monday writes={'ON' if args.live else 'PREVIEW'} | "
          f"HubSpot writes={'ON' if args.write_hubspot else 'PREVIEW'}")
    ctx, owners_by_id, pipeline_id = r.build_context(config)
    ctx["dealtype_rev"] = {v: k for k, v in ctx["dealtype_labels"].items()}
    ctx["priority_rev"] = {v: k for k, v in ctx["priority_labels"].items()}
    owner_ids = r.configured_owner_ids(config, owners_by_id)
    props_list = sorted(set(r.deal_properties(ctx["field_map"])) | {"hs_lastmodifieddate"})
    deals = r.fetch_deals(pipeline_id, owner_ids, props_list)

    board_items = {}

    def items_for(board):
        if board not in board_items:
            board_items[board] = r.get_board_items(board)
        return board_items[board]

    def find_item(board, deal_id):
        for it in items_for(board):
            if col_text(it, ctx["deal_id_col"]) == str(deal_id):
                return it
        return None

    stats = {"in_sync": 0, "to_monday": 0, "to_hubspot": 0, "created": 0, "skipped": 0}
    for deal in deals:
        parsed = r.parse_deal(deal)
        props = deal["properties"]
        oinfo = owners_by_id.get(str(parsed["owner_id"]), {}) or {}
        match = r.match_owner_config(parsed["owner_id"], oinfo.get("name"),
                                     oinfo.get("email"), config)
        if not match:
            stats["skipped"] += 1
            continue
        owner_key, entry = match
        board = entry["monday_board_id"]
        stage_to_group = entry.get("stage_to_group", {})
        rev_group_to_stage = {g: s for s, g in stage_to_group.items()}
        item = find_item(board, deal["id"])

        if not item:                                   # forward create
            group = stage_to_group.get(str(parsed["stage"]))
            if not group:
                stats["skipped"] += 1
                continue
            cv = r.build_column_values(props, deal["id"], ctx["board_columns"].get(board, {}),
                                       ctx["field_map"], ctx["deal_id_col"], ctx)
            r.create_item(board, group, parsed["name"] or f"Deal {deal['id']}", cv)
            stats["created"] += 1
            continue

        diffs = field_diffs(item, props, rev_group_to_stage, ctx)
        if not diffs:
            stats["in_sync"] += 1
            continue

        hs_time = parse_iso(props.get("hs_lastmodifieddate")) or dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        md_time = parse_iso(item.get("updated_at")) or dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        changed = ", ".join(d["label"] for d in diffs)

        if md_time > hs_time:                          # reverse: monday -> HubSpot
            patch = {d["hs_prop"]: d["md"] for d in diffs}
            print(f"deal {deal['id']} '{item.get('name')}' : monday newer -> PATCH HubSpot [{changed}]")
            print(f"    {patch}")
            if args.write_hubspot:
                try:
                    r.hubspot("PATCH", f"/crm/v3/objects/deals/{deal['id']}",
                              json={"properties": patch})
                    print("    -> HubSpot updated")
                except Exception as ex:
                    print(f"    -> HubSpot write FAILED: {ex}")
                    if "403" in str(ex):
                        print("       add the 'crm.objects.deals.write' scope to your "
                              "HubSpot private app, then retry")
            stats["to_hubspot"] += 1
        else:                                          # forward: HubSpot -> monday
            cv = r.build_column_values(props, deal["id"], ctx["board_columns"].get(board, {}),
                                       ctx["field_map"], ctx["deal_id_col"], ctx)
            print(f"deal {deal['id']} '{parsed['name']}' : HubSpot newer -> update monday [{changed}]")
            r.update_item(board, item["id"], parsed["name"] or f"Deal {deal['id']}", cv)
            stats["to_monday"] += 1

    print(f"SUMMARY: {stats}")


if __name__ == "__main__":
    main()

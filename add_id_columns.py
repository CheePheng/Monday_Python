"""Adds a 'HubSpot ID' numbers column to the Company and Contact boards (dedup key)."""
import owner_router_test as r

MUT = 'mutation ($b:ID!) { create_column(board_id:$b, title:"HubSpot ID", column_type:numbers) { id } }'
for board in ("5029639440", "5029639630"):
    col = r.monday_query(MUT, {"b": board})["create_column"]["id"]
    print(f"board {board} -> HubSpot ID column id: {col}")

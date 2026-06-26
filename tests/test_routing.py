import owner_router_test as r

CONFIG = {"owners": {
    "Matthew Ng": {"hubspot_owner_id": "555", "monday_board_id": "B1", "monday_group_title": "Sales Pipeline"},
    "John Aldrin Bautista": {"monday_board_id": "B2", "monday_group_title": "Sales Pipeline"}}}

COLS = {"hubspot_deal_id": "c_id", "deal_name": "c_name", "deal_owner": "c_owner",
        "deal_stage": "c_stage", "amount": "c_amt"}

ITEMS = [
    {"id": "i1", "name": "Old", "column_values": [{"id": "text_deal", "text": "9001"}]},
    {"id": "i2", "name": "Other", "column_values": [{"id": "text_deal", "text": "9002"}]},
]


# --- parse_deal ---

def test_parse_deal_extracts_properties():
    raw = {"id": "9001", "properties": {
        "dealname": "Acme Renewal", "amount": "5000",
        "dealstage": "qualified", "closedate": "2026-07-01",
        "hubspot_owner_id": "555", "pipeline": "p1"}}
    d = r.parse_deal(raw)
    assert d == {"id": "9001", "name": "Acme Renewal", "owner_id": "555",
                 "stage": "qualified", "amount": "5000", "close_date": "2026-07-01"}


# --- match_owner_config ---

def test_match_by_owner_id():
    key, entry = r.match_owner_config("555", "Matthew Ng", CONFIG)
    assert key == "Matthew Ng" and entry["monday_board_id"] == "B1"


def test_match_by_name_when_no_id():
    key, entry = r.match_owner_config("999", "John Aldrin Bautista", CONFIG)
    assert key == "John Aldrin Bautista" and entry["monday_board_id"] == "B2"


def test_unmapped_owner_returns_none():
    assert r.match_owner_config("123", "Someone Else", CONFIG) is None


# --- find_existing_item ---

def test_find_existing_item_hit():
    assert r.find_existing_item(ITEMS, "text_deal", "9002")["id"] == "i2"


def test_find_existing_item_miss():
    assert r.find_existing_item(ITEMS, "text_deal", "7777") is None


# --- build_column_values ---

def test_build_column_values_maps_all_fields():
    deal = {"id": "9001", "name": "Acme", "stage": "qualified", "amount": "5000"}
    cv = r.build_column_values(deal, "Matthew Ng", COLS)
    assert cv == {"c_id": "9001", "c_name": "Acme", "c_owner": "Matthew Ng",
                  "c_stage": "qualified", "c_amt": "5000"}


def test_build_column_values_skips_placeholder_columns():
    cv = r.build_column_values({"id": "1", "name": "x", "stage": "s", "amount": None},
                               "O", {"hubspot_deal_id": "PUT_COLUMN_ID_HERE"})
    assert cv == {}


# --- integration: route_deals (network monkeypatched) ---

def _setup(monkeypatch, items):
    monkeypatch.setattr(r, "get_group_id", lambda b, t: "g1")
    monkeypatch.setattr(r, "get_group_items", lambda b, g: items)
    created, updated = [], []
    monkeypatch.setattr(r, "create_item", lambda b, g, n, c: created.append((n, c)))
    monkeypatch.setattr(r, "update_item", lambda b, i, c: updated.append((i, c)))
    return created, updated


DEAL = {"id": "9001", "properties": {"dealname": "Acme", "amount": "5000",
        "dealstage": "qualified", "closedate": "2026-07-01",
        "hubspot_owner_id": "555", "pipeline": "p1"}}
OWNERS = {"555": {"name": "Matthew Ng", "email": "m@x.com"}}
FULLCONFIG = {"hubspot_pipeline_id": "p1", "owners": CONFIG["owners"], "monday_columns": COLS}


def test_new_deal_is_created(monkeypatch):
    created, updated = _setup(monkeypatch, items=[])
    stats = r.route_deals(FULLCONFIG, OWNERS, [DEAL])
    assert stats == {"processed": 1, "created": 1, "updated": 0, "skipped": 0}
    assert created and not updated


def test_existing_deal_is_updated_not_duplicated(monkeypatch):
    items = [{"id": "i1", "name": "Acme",
              "column_values": [{"id": "c_id", "text": "9001"}]}]
    created, updated = _setup(monkeypatch, items=items)
    stats = r.route_deals(FULLCONFIG, OWNERS, [DEAL])
    assert stats == {"processed": 1, "created": 0, "updated": 1, "skipped": 0}
    assert updated and not created


def test_unmapped_owner_is_skipped(monkeypatch):
    created, updated = _setup(monkeypatch, items=[])
    stats = r.route_deals(FULLCONFIG, {"999": {"name": "Ghost"}},
                          [{"id": "1", "properties": {"hubspot_owner_id": "999"}}])
    assert stats["skipped"] == 1 and not created and not updated

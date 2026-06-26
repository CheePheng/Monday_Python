import owner_router_test as r

CONFIG = {"owners": {
    "Matthew Ng": {"hubspot_owner_id": "555", "monday_board_id": "B1",
                   "stage_to_group": {"appointmentscheduled": "g_appt"}},
    "John Aldrin Bautista": {"email": "aldrin@dkmeco.com", "monday_board_id": "B2",
                             "stage_to_group": {"appointmentscheduled": "g_appt"}}}}

# Lookup maps the formatter/router need (a fake "context").
CTX = {
    "owners_by_id": {"555": {"name": "Matthew Ng", "email": "m@x.com"}},
    "email_to_muser": {"m@x.com": "1001"},
    "stages": {"appointmentscheduled": "Appointment Scheduled"},
    "pipeline_label": "Sales Pipeline",
    "dealtype_labels": {"existingbusiness": "Existing Business"},
    "priority_labels": {"medium": "Medium"},
    "field_map": {}, "deal_id_col": "c_id", "link_col": None, "portal_id": None,
    "board_columns": {},
}


# --- parse_deal ---

def test_parse_deal_extracts_properties():
    raw = {"id": "9001", "properties": {
        "dealname": "Acme Renewal", "amount": "5000",
        "dealstage": "qualified", "closedate": "2026-07-01",
        "hubspot_owner_id": "555", "pipeline": "p1"}}
    assert r.parse_deal(raw) == {"id": "9001", "name": "Acme Renewal", "owner_id": "555",
                                 "stage": "qualified", "amount": "5000", "close_date": "2026-07-01"}


# --- match_owner_config ---

def test_match_by_owner_id():
    key, entry = r.match_owner_config("555", "Matthew Ng", "m@x.com", CONFIG)
    assert key == "Matthew Ng" and entry["monday_board_id"] == "B1"


def test_match_by_email():
    key, entry = r.match_owner_config("999", "Different Name", "aldrin@dkmeco.com", CONFIG)
    assert key == "John Aldrin Bautista" and entry["monday_board_id"] == "B2"


def test_match_by_name_when_no_id_or_email():
    key, entry = r.match_owner_config("999", "John Aldrin Bautista", None, CONFIG)
    assert key == "John Aldrin Bautista" and entry["monday_board_id"] == "B2"


def test_unmapped_owner_returns_none():
    assert r.match_owner_config("123", "Someone Else", "nope@x.com", CONFIG) is None


# --- build_stage_to_group ---

def test_build_stage_to_group_matches_label_in_title():
    groups = [{"id": "g1", "title": "Sales Pipeline 01 - Appointment Scheduled"},
              {"id": "g2", "title": "Sales Pipeline 02 - Qualified To Buy"},
              {"id": "g6", "title": "Sales Pipeline 06 - Closed Won"}]
    stages = {"appointmentscheduled": "Appointment Scheduled",
              "qualifiedtobuy": "Qualified To Buy",
              "closedwon": "Closed Won", "weird": "No Such Group"}
    assert r.build_stage_to_group(groups, stages) == {
        "appointmentscheduled": "g1", "qualifiedtobuy": "g2", "closedwon": "g6"}


# --- find_existing_item ---

def test_find_existing_item_hit():
    items = [{"id": "i2", "column_values": [{"id": "c_id", "text": "9002"}]}]
    assert r.find_existing_item(items, "c_id", "9002")["id"] == "i2"


def test_find_existing_item_miss():
    items = [{"id": "i2", "column_values": [{"id": "c_id", "text": "9002"}]}]
    assert r.find_existing_item(items, "c_id", "7777") is None


# --- format_column_value (per column type) ---

def test_format_status_uses_stage_label():
    assert r.format_column_value("dealstage", "status", "appointmentscheduled", CTX) == \
        {"label": "Appointment Scheduled"}


def test_format_people_resolves_monday_user():
    assert r.format_column_value("hubspot_owner_id", "people", "555", CTX) == \
        {"personsAndTeams": [{"id": 1001, "kind": "person"}]}


def test_format_dropdown_maps_dealtype_label():
    assert r.format_column_value("dealtype", "dropdown", "existingbusiness", CTX) == \
        {"labels": ["Existing Business"]}


def test_format_date_truncates_to_day():
    assert r.format_column_value("createdate", "date", "2026-06-26T02:22:45Z", CTX) == \
        {"date": "2026-06-26"}


def test_format_numbers_is_string():
    assert r.format_column_value("amount", "numbers", 123, CTX) == "123"


def test_format_none_value_is_skipped():
    assert r.format_column_value("dealtype", "dropdown", None, CTX) is None


# --- build_column_values (full payload) ---

def test_build_column_values_full_payload():
    props = {"dealstage": "appointmentscheduled", "hubspot_owner_id": "555",
             "dealtype": "existingbusiness"}
    field_map = {"dealstage": "c_stage", "hubspot_owner_id": "c_owner", "dealtype": "c_type"}
    columns_meta = {"c_stage": "status", "c_owner": "people", "c_type": "dropdown"}
    cv = r.build_column_values(props, "9001", columns_meta, field_map, "c_id", CTX)
    assert cv == {"c_id": "9001",
                  "c_stage": {"label": "Appointment Scheduled"},
                  "c_owner": {"personsAndTeams": [{"id": 1001, "kind": "person"}]},
                  "c_type": {"labels": ["Existing Business"]}}


# --- configured_owner_ids ---

def test_configured_owner_ids_uses_id_then_email():
    owners_by_id = {"555": {"name": "Matthew Ng", "email": "m@x.com"},
                    "999": {"name": "Someone", "email": "aldrin@dkmeco.com"}}
    assert set(r.configured_owner_ids(CONFIG, owners_by_id)) == {"555", "999"}


# --- integration: route_deals (network monkeypatched) ---

def _ctx(owners_by_id):
    return {**CTX, "owners_by_id": owners_by_id, "field_map": {}, "deal_id_col": "c_id",
            "board_columns": {}}


def _setup(monkeypatch, items):
    monkeypatch.setattr(r, "get_board_items", lambda b: items)
    created, updated = [], []
    monkeypatch.setattr(r, "create_item", lambda b, g, n, c: created.append((g, n, c)))
    monkeypatch.setattr(r, "update_item", lambda b, i, n, c: updated.append((i, n, c)))
    return created, updated


DEAL = {"id": "9001", "properties": {"dealname": "Acme", "dealstage": "appointmentscheduled",
        "hubspot_owner_id": "555"}}
OWNERS = {"555": {"name": "Matthew Ng", "email": "m@x.com"}}
FULLCONFIG = {"hubspot_pipeline_id": "p1", "owners": CONFIG["owners"]}


def test_new_deal_is_created_in_its_stage_group(monkeypatch):
    created, updated = _setup(monkeypatch, items=[])
    stats = r.route_deals(FULLCONFIG, [DEAL], _ctx(OWNERS))
    assert stats == {"processed": 1, "created": 1, "updated": 0, "skipped": 0}
    assert created and not updated
    assert created[0][0] == "g_appt"        # placed in the group matching its stage


def test_existing_deal_is_updated_not_duplicated(monkeypatch):
    items = [{"id": "i1", "name": "Acme", "group": {"id": "g_other"},
              "column_values": [{"id": "c_id", "text": "9001"}]}]
    created, updated = _setup(monkeypatch, items=items)
    stats = r.route_deals(FULLCONFIG, [DEAL], _ctx(OWNERS))
    assert stats == {"processed": 1, "created": 0, "updated": 1, "skipped": 0}
    assert updated and not created          # NO duplicate
    assert updated[0][1] == "Acme"          # name passed through on update


def test_unmapped_owner_is_skipped(monkeypatch):
    created, updated = _setup(monkeypatch, items=[])
    deal = {"id": "1", "properties": {"hubspot_owner_id": "999",
                                      "dealstage": "appointmentscheduled"}}
    stats = r.route_deals(FULLCONFIG, [deal], _ctx({"999": {"name": "Ghost"}}))
    assert stats["skipped"] == 1 and not created and not updated


def test_unmapped_stage_is_skipped(monkeypatch):
    created, updated = _setup(monkeypatch, items=[])
    deal = {"id": "7", "properties": {"hubspot_owner_id": "555", "dealstage": "contractsent"}}
    stats = r.route_deals(FULLCONFIG, [deal], _ctx(OWNERS))
    assert stats["skipped"] == 1 and not created and not updated

import { describe, it, expect } from "vitest";
import { readWranglerConfig, readWmConfig } from "../scripts/read-wrangler.mjs";
import { scanWriteMode } from "../scripts/scan-write-mode.mjs";
import { writeModeFor, maxWritesFor, webhookOpts } from "../src/run-opts";
import { birthLinksOn, createWindowReplayOn, labelDictsFor } from "../src/sync";
import { specsFor, specByBoard, specByObject, ALL_SPECS } from "../src/config";
import { CRM_SPECS } from "../src/config/crm";
import { cutoverFromEnv } from "../src/ownership";

/**
 * DEPLOYMENT CONFIG REGRESSION.
 *
 * This file exists because of a specific near-miss: every routing test asserted that
 * `specsFor({ENABLE_CRM:"true"})` returns the CRM specs, and they all passed — while the actual
 * deployable `wrangler.jsonc` never set ENABLE_CRM at all. Deploying it would have produced a Worker
 * resolving the WORK MANAGEMENT specs: a second processor for the live WM boards, holding a token that
 * can write HubSpot. The code was right and the config was wrong, so no code test could see it.
 *
 * These tests read the real file.
 */

const cfg = readWranglerConfig();
const vars = (cfg.vars ?? {}) as Record<string, string>;

describe("the deployable CRM Wrangler config", () => {
  it("targets the CRM Worker, NOT the live WM Worker", () => {
    expect(cfg.name).toBe("hubspot-monday-crm-sync");
    expect(cfg.name).not.toBe("hubspot-monday-sync");
  });

  it("pins the COMPANY Cloudflare account", () =>
    expect(cfg.account_id).toBe("5f4d31a75fd669df8527210deb973591"));

  // THE ONE THAT WAS MISSING.
  it("sets ENABLE_CRM=\"true\" — without it the Worker resolves the WM specs", () =>
    expect(vars.ENABLE_CRM).toBe("true"));

  it("ships with DRY_RUN=\"true\" as the checked-in default", () =>
    expect(vars.DRY_RUN).toBe("true"));

  it("ships with WRITE_HUBSPOT=\"false\" so no HubSpot mutation is possible", () =>
    expect(vars.WRITE_HUBSPOT).toBe("false"));

  /**
   * AN ALLOWLIST OF EXACTLY ONE. The marketing email poller needs the 15-minute cron; every other
   * expression index.ts dispatches would switch on something deliberately off on CRM -- the 5-minute
   * one the Task poller, the 10-minute and 03:00 ones the CRM incremental and full sweeps (ruled out
   * 2026-09-07), 04:00 the Task sweep.
   */
  it("declares exactly ONE cron, */15, for the marketing poller -- no unattended sweeps", () => {
    expect(cfg.triggers?.crons).toEqual(["*/15 * * * *"]);
    for (const off of ["*/5 * * * *", "*/10 * * * *", "0 3 * * *", "0 4 * * *"])
      expect(cfg.triggers?.crons).not.toContain(off);
  });

  it("ships the marketing poller OFF, with no cursors and the default cap", () => {
    expect(vars.ENABLE_MARKETING_EMAIL_SYNC).toBe("false");
    expect(vars.MARKETING_CUTOVER_AT).toBe("");
    expect(vars.MARKETING_BACKFILL_FROM).toBe("");
    expect(vars.MARKETING_MAX_WRITES_PER_POLL).toBe("60");
    expect(vars.MARKETING_CANARY_CONTACT_IDS).toBeUndefined();
  });

  /**
   * The Last Activity backstop sweep (lad-sweep.ts) rides the 15-minute cron, and ships OFF: only the literal
   * "true" arms it, which the deploy passes as --var once the webhook fix has been watched live.
   */
  it("ships the Last Activity sweep OFF (ENABLE_LAD_SWEEP=\"false\"), on the one existing cron", () => {
    expect(vars.ENABLE_LAD_SWEEP).toBe("false");
    expect(cfg.triggers?.crons).toEqual(["*/15 * * * *"]);   // no cron of its own
  });

  /** The derived P&S Account reverse (line item's Account -> its deal's company) is opt-in. Shipped
   *  "false", and only the literal "true" arms it, so a missing or odd value keeps the cell read-only. */
  it("ships with PS_ACCOUNT_REVERSE=\"false\" -- the derived P&S Account cell stays read-only", () =>
    expect(vars.PS_ACCOUNT_REVERSE).toBe("false"));

  it("the WM config does not arm it either", () =>
    expect(((readWmConfig().vars ?? {}) as Record<string, string>).PS_ACCOUNT_REVERSE).not.toBe("true"));

  /**
   * THE TWO CREATE-PATH KILL SWITCHES ship OFF, so a bare `wrangler deploy` is the old create path: no birth
   * links (BORN_ATTACHED_LINKS) and no create-window replay (CREATE_WINDOW_REPLAY). The deploy passes both
   * as "true" with --var, and either can be flipped back in the dashboard without a code change.
   */
  it("ships BORN_ATTACHED_LINKS=\"false\" and CREATE_WINDOW_REPLAY=\"false\" -- a bare deploy is the old create path", () => {
    expect(vars.BORN_ATTACHED_LINKS).toBe("false");
    expect(vars.CREATE_WINDOW_REPLAY).toBe("false");
    // ...and the shipped values really do read as OFF where the code asks.
    expect(birthLinksOn(vars)).toBe(false);
    for (const s of specsFor(vars)) expect(createWindowReplayOn(vars, s)).toBe(false);
    // The deploy's --var value arms them on these boards (so the check above is not vacuous).
    expect(birthLinksOn({ ...vars, BORN_ATTACHED_LINKS: "true" })).toBe(true);
    expect(specsFor(vars).filter(s => createWindowReplayOn({ ...vars, CREATE_WINDOW_REPLAY: "true" }, s)).length)
      .toBeGreaterThan(0);
  });

  it("the WM config does not arm either create-path switch", () => {
    const wmVars = (readWmConfig().vars ?? {}) as Record<string, string>;
    expect(wmVars.BORN_ATTACHED_LINKS).not.toBe("true");
    expect(wmVars.CREATE_WINDOW_REPLAY).not.toBe("true");
  });

  it("does NOT commit a temporary test cutover", () => {
    expect(vars.CRM_CUTOVER_AT).toBeUndefined();
    // ...and an absent value is fail-closed.
    expect(cutoverFromEnv(vars.CRM_CUTOVER_AT)).toBe(Number.POSITIVE_INFINITY);
  });

  it("has its own Durable Object namespace, so CRM state cannot collide with production's", () => {
    expect(JSON.stringify(cfg.durable_objects)).toContain("CREATE_IDEMPOTENCY");
    expect(JSON.stringify(cfg.migrations)).toContain("CreateIdempotency");
  });

  // The config's own vars must produce the intended Phase-A behaviour end to end.
  it("the shipped vars yield NO writes of any kind", () => {
    const opts = writeModeFor(vars, maxWritesFor(vars));
    expect(opts.dryRun).toBe(true);
    expect(opts.writeHubspot).toBe(false);
  });

  // Four boards since 2026-09-14 (Deals 5028000494 and Line Items 5028000489 joined). Pinned so a new
  // board is a deliberate edit here, and so a WM board appearing in this list fails loudly.
  it("and resolve to exactly the four CRM boards", () => {
    expect(specsFor(vars).map(s => s.boardId).sort())
      .toEqual(["5028000489", "5028000494", "5028000495", "5028000496"]);
  });
});

describe("write mode — every combination", () => {
  const mode = (DRY_RUN?: string, WRITE_HUBSPOT?: string) => writeModeFor({ DRY_RUN, WRITE_HUBSPOT }, 25);

  it("WM PRODUCTION (DRY_RUN=false, no WRITE_HUBSPOT) is UNCHANGED — HubSpot writes stay on", () =>
    expect(mode("false", undefined)).toMatchObject({ dryRun: false, writeHubspot: true }));

  it("CRM Phase A (DRY_RUN=true, WRITE_HUBSPOT=false): nothing writes", () =>
    expect(mode("true", "false")).toMatchObject({ dryRun: true, writeHubspot: false }));

  it("CRM Phase B (DRY_RUN=false, WRITE_HUBSPOT=false): real monday writes, ZERO HubSpot", () =>
    expect(mode("false", "false")).toMatchObject({ dryRun: false, writeHubspot: false }));

  it("dry-run ALWAYS suppresses HubSpot writes, whatever WRITE_HUBSPOT says", () => {
    for (const w of ["true", "false", undefined, "yes"])
      expect(mode("true", w).writeHubspot).toBe(false);
  });

  // Opt-OUT: only the exact string "false" disables. Anything else must leave production alone.
  it.each(["true", "TRUE", "", "1", "no", undefined])(
    "WRITE_HUBSPOT=%j with DRY_RUN=false keeps HubSpot writes ENABLED", (w) =>
      expect(mode("false", w).writeHubspot).toBe(true));

  it("an unset DRY_RUN is dry — a missing var never turns writes on", () =>
    expect(mode(undefined, undefined)).toMatchObject({ dryRun: true, writeHubspot: false }));

  // REGRESSION, found 2026-09-08. run-opts.ts calls itself "THE SINGLE PLACE that decides whether
  // writes actually happen" and it was not: webhooks.ts computed its own `{ writeHubspot: live }` and
  // never read WRITE_HUBSPOT. That is the only live SYNC path on the CRM deployment — no sync crons (the
  // only cron, */15, dispatches the marketing poller and nothing else), and both CRM specs set
  // skipFullReconcile — so Phase B's HubSpot kill switch was inert exactly where it
  // mattered, and the sole thing refusing reverse writes was the ownership gate.
  it("the WEBHOOK path honours WRITE_HUBSPOT — it is the only live path on the CRM worker", () => {
    expect(webhookOpts({ DRY_RUN: "false", WRITE_HUBSPOT: "false" }))
      .toMatchObject({ dryRun: false, writeHubspot: false });
    expect(webhookOpts({ DRY_RUN: "false" }))
      .toMatchObject({ dryRun: false, writeHubspot: true });   // WM production, unchanged
    expect(webhookOpts({ DRY_RUN: "true", WRITE_HUBSPOT: "false" }))
      .toMatchObject({ dryRun: true, writeHubspot: false });
  });

  it("a webhook gets a per-event write budget, not a cron-sized one", () =>
    expect(webhookOpts({ DRY_RUN: "false" }).maxWrites).toBe(30));

  // Belt and braces: no module may re-derive writeHubspot for itself again. A duplicate is invisible
  // to every behavioural test — each copy is individually correct — so only a source scan finds it.
  it("no source file computes writeHubspot outside run-opts.ts", () =>
    expect(scanWriteMode()).toEqual([]));

  it("maxWrites falls back safely on junk input", () => {
    expect(maxWritesFor({ MAX_WRITES: "50" })).toBe(50);
    for (const v of ["0", "-1", "abc", "", undefined]) expect(maxWritesFor({ MAX_WRITES: v })).toBe(25);
  });
});

/**
 * The point of this block was never "CRM avoids Deals" — it is that a deployment fetches ONLY the
 * metadata its own specs reference, so neither app needs a scope it has no business holding. That
 * property is unchanged; what changed on 2026-09-14 is which specs CRM owns. The four Deals and Line
 * Items scopes were granted for exactly this, and verified live the same day.
 */
describe("spec-driven metadata: each deployment fetches only what its specs reference", () => {
  const prod = {} as { ENABLE_CRM?: string };
  const crmEnv = { ENABLE_CRM: "true" };

  it("CRM now loads the deal + line-item dictionaries, because it owns those objects", () => {
    const dicts = labelDictsFor(crmEnv);
    for (const d of ["crmStage", "crmPipeline", "dealtype", "priority", "vendor", "liBrand"])
      expect(dicts).toContain(d);
  });

  /**
   * `crmStage` is NOT interchangeable with `stage`, and this is the assertion that keeps them apart:
   * `stage` covers the default pipeline only, while this portal has 42 stages across 5 pipelines with
   * DUPLICATE labels (赢单 is three distinct ids). CRM must carry the pipeline-qualified dictionary or
   * a reverse write can move a deal into the wrong pipeline.
   */
  it("CRM carries the pipeline-qualified stage dictionary, not just the default-pipeline one", () => {
    expect(labelDictsFor(crmEnv)).toContain("crmStage");
  });

  it("CRM loads exactly the dictionaries its fields reference", () =>
    expect(labelDictsFor(crmEnv).sort())
      // Pinned so an accidental addition shows up as a deliberate change to this list — each entry
      // costs one HubSpot schema fetch per run. `industry` is absent because company industry is
      // unmapped and the contact-level one is free text with no dictionary. `contactSalesPerson`
      // left the list on 2026-09-15 when Sales Person was retired from monday: the DICTS entry still
      // exists, but nothing references it, so nothing fetches it — which is the property this test
      // is really pinning.
      //
      // `stage` LEFT and `crmCoarseStage` ARRIVED on 2026-09-15, and the swap is the whole point of
      // that day's second incident. `stage` is built by getDealStageLabels, which reads HubSpot's
      // DEFAULT PIPELINE ONLY; the coarse Deals Stage column was mapped to it, so all four Salesforce
      // pipelines fell through `dict[v] ?? v` and minted monday status labels named after raw stage
      // GUIDs. `crmCoarseStage` covers every pipeline. CRM must no longer reference `stage` AT ALL —
      // that absence is an assertion, not an accident.
      .toEqual(["companyType", "contactCity", "contactCountries", "contactDepartment",
                "contactLeadSourceSub", "contactPriority", "contactSource",
                "contactStatus", "contactVendor", "crmCoarseStage", "crmPipeline", "crmStage",
                "dealtype", "leadStatus",
                "liBillingFreq", "liBrand", "liFamily", "liIsActive", "liPricingModel",
                "liSubcategory", "liTaxRate", "lifecycleStage", "partnerWith", "priority",
                "vendor"]));   // `pipeline` left too: its only CRM user was deal_currency_code, wired to it by mistake   // `salesUser` left on 2026-09-23 with the two unmapped Sales User dropdowns;
                               // `liCurrency` left the same day (it fetched EMPTY -- see FieldSpec.reverseAs)

  // WM REGRESSION: it must still load everything it loaded before the refactor.
  it("WM still loads every dictionary it used to fetch unconditionally", () => {
    const dicts = labelDictsFor(prod);
    for (const d of ["stage", "dealtype", "priority", "vendor", "leadStatus", "contactSource",
                     "contactVendor", "industry", "companyType", "partnerWith"])
      expect(dicts).toContain(d);
  });

  it("every dictionary a spec references is one buildCtx knows how to load", () => {
    for (const env of [prod, crmEnv])
      for (const spec of specsFor(env))
        for (const f of spec.fields)
          if (f.labels) expect(labelDictsFor(env)).toContain(f.labels);
  });
});

describe("CRM_CUTOVER_AT is deployment config, and fails closed", () => {
  const crm = (CRM_CUTOVER_AT?: string) => specsFor({ ENABLE_CRM: "true", CRM_CUTOVER_AT });
  const cutoverOf = (CRM_CUTOVER_AT?: string) => crm(CRM_CUTOVER_AT)[0].ownership!.cutoverAtMs;

  it("unset leaves the inert shipped cutover, and returns the ORIGINAL spec objects", () => {
    expect(cutoverOf(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(crm(undefined)).toBe(CRM_SPECS);          // identity preserved for the default path
  });

  it("a real ISO timestamp is applied to BOTH specs", () => {
    const want = Date.parse("2026-09-07T11:00:00Z");
    for (const s of crm("2026-09-07T11:00:00Z")) expect(s.ownership!.cutoverAtMs).toBe(want);
  });

  it("epoch milliseconds work too", () =>
    expect(cutoverOf(String(Date.parse("2026-10-01T00:00:00Z"))))
      .toBe(Date.parse("2026-10-01T00:00:00Z")));

  // FAIL CLOSED. Each of these is a plausible operator slip, and every one must leave the CRM path
  // unable to claim or card anything rather than silently choosing a cutover in the distant past.
  it.each(["", "   ", "0", "1", "2026", "20261001", "not-a-date", "1e21", "1970-01-01T00:00:00Z",
           "2199-01-01T00:00:00Z", "3000-01-01T00:00:00Z"])(
    "CRM_CUTOVER_AT=%j fails closed to Infinity", (v) =>
      expect(cutoverOf(v)).toBe(Number.POSITIVE_INFINITY));

  it("applying a cutover changes ONLY the cutover — board, columns and owner are untouched", () => {
    const [acc, con] = crm("2026-09-07T11:00:00Z");
    expect(acc.boardId).toBe(CRM_SPECS[0].boardId);
    expect(con.boardId).toBe(CRM_SPECS[1].boardId);
    expect(con.ownership!.owner).toBe("crm");
    expect(con.ownership!.prop).toBe("sync_owner");
    expect(con.fields).toBe(CRM_SPECS[1].fields);     // same field array, not a rebuilt one
  });

  it("the WM deployment now HONOURS CRM_CUTOVER_AT — the same timestamp must reach both", () => {
    // NOT the same objects any more: a finite cutover is applied to the WM specs too, so specsFor
    // returns copies carrying it. That IS the fix — a cutover only one side honours is precisely the
    // split-brain the ownership model exists to prevent.
    const AT = "2026-09-07T11:00:00Z";
    const wm = specsFor({ CRM_CUTOVER_AT: AT });
    expect(wm).toHaveLength(ALL_SPECS.length);
    for (const s of wm) {
      expect(s.ownership?.owner).toBe("wm");
      expect(s.ownership?.cutoverAtMs).toBe(Date.parse(AT));
    }
    // Identity is still preserved when the var is absent, which callers compare on.
    expect(specsFor({})).toBe(ALL_SPECS);
  });

  it("board/object resolution still works with a cutover set", () => {
    const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-07T11:00:00Z" };
    expect(specByBoard(env, "5028000495")?.object).toBe("contacts");
    expect(specByObject(env, "companies")?.boardId).toBe("5028000496");
    // Deals resolve on CRM since 2026-09-14 — to the CRM board, never the WM one.
    expect(specByObject(env, "deals")?.boardId).toBe("5028000494");
  });
});

/**
 * THE SAME CLASS OF BUG, ON THE OTHER WORKER.
 *
 * The ownership guard has to ship to the LIVE Work Management Worker, and this repo's wrangler.jsonc
 * is the CRM Worker's. master carries a WM config, but it has regressed since the deploy that created
 * WM's Durable Object: it dropped the CREATE_IDEMPOTENCY binding, dropped the migration that made the
 * class, and dropped LINE_ITEM_WRITE. Deploying master's config would silently switch off reverse
 * line-item writes and detach live create-dedup state.
 *
 * wrangler.wm.jsonc is reconciled against commit d801b50 -- the config that actually created that
 * namespace -- and against what the deployed Worker reports today. These tests pin it, because
 * `wrangler deploy --dry-run` validates the bundle and never once contacts the Worker it targets.
 */
describe("the deployable Work Management Wrangler config", () => {
  const wm = readWmConfig();
  const wmVars = (wm.vars ?? {}) as Record<string, string>;

  it("targets the LIVE WM Worker, not the CRM one", () => {
    expect(wm.name).toBe("hubspot-monday-sync");
    expect(wm.name).not.toBe("hubspot-monday-crm-sync");
  });

  // Omitting ENABLE_CRM is what makes this Worker resolve the WM specs. Asserting the ABSENCE is the
  // point: setting it would aim a second processor at the CRM boards.
  it("does NOT set ENABLE_CRM, so it resolves the Work Management specs", () => {
    expect(wmVars.ENABLE_CRM).toBeUndefined();
    expect(specsFor(wmVars).map(s => s.boardId).sort()).toEqual(ALL_SPECS.map(s => s.boardId).sort());
    for (const s of specsFor(wmVars)) expect(CRM_SPECS).not.toContain(s);
  });

  it("keeps production's write posture — this Worker is live and must stay live", () => {
    expect(wmVars.DRY_RUN).toBe("false");
    expect(writeModeFor(wmVars, maxWritesFor(wmVars))).toMatchObject({ dryRun: false, writeHubspot: true });
  });

  // Each of these three was present on the deploy that built the live Worker and is absent from
  // master's current config. Dropping any one of them is a silent production regression.
  it("keeps LINE_ITEM_WRITE=true, which master's config dropped", () =>
    expect(wmVars.LINE_ITEM_WRITE).toBe("true"));

  it("keeps MAX_WRITES at the deployed value", () =>
    expect(wmVars.MAX_WRITES).toBe("100"));

  it("keeps BOTH crons — deploying the CRM config's shape would disable the sweeps", () =>
    expect(wm.triggers?.crons).toEqual(["*/10 * * * *", "0 3 * * *"]));

  /** WM runs the same source, so the marketing poller must have no way in: no 15-minute cron, no flag. */
  it("never schedules or enables the marketing poller", () => {
    expect(wm.triggers?.crons).not.toContain("*/15 * * * *");
    for (const k of Object.keys(wmVars)) expect(k.startsWith("MARKETING_")).toBe(false);
    expect(wmVars.ENABLE_MARKETING_EMAIL_SYNC).toBeUndefined();
  });

  /** Nor the Last Activity sweep: no flag, and no 15-minute cron to run it on. */
  it("never enables the Last Activity sweep", () => {
    expect(wmVars.ENABLE_LAD_SWEEP).toBeUndefined();
    expect(wm.triggers?.crons).not.toContain("*/15 * * * *");
  });

  it("re-declares CREATE_IDEMPOTENCY and its original v1 migration, and nothing else", () => {
    expect(wm.durable_objects?.bindings)
      .toEqual([{ name: "CREATE_IDEMPOTENCY", class_name: "CreateIdempotency" }]);
    // Exactly the tag and form from d801b50, so the already-applied migration replays as a no-op.
    expect(wm.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["CreateIdempotency"] }]);
  });

  // index.ts exports all three DO classes, but WM binds only one. v2/v3 belong to the CRM Worker;
  // replaying them here would create two live namespaces on a Worker that never asked for them.
  it("does NOT bind or migrate the activity namespaces", () => {
    const text = JSON.stringify(wm);
    expect(text).not.toContain("ActivityRetry");
    expect(text).not.toContain("DeferredSync");
  });

  it("does not commit a cutover value — CRM_CUTOVER_AT is a secret, already set on the Worker", () =>
    expect(wmVars.CRM_CUTOVER_AT).toBeUndefined());
});

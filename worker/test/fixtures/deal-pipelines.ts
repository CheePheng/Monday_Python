/**
 * Portal 39939588's deal pipelines, for the coarse Stage reverse (STAGE_COARSE_REVERSE).
 *
 * MEASURED, NOT MODELLED: every id, label, displayOrder and metadata value below is copied from a
 * read-only GET /crm/v3/pipelines/deals on 2026-10-01. A hand-made Salesforce pipeline once let the
 * Lost rule pass its tests while sending every live Salesforce deal to 暂停 (Paused): it had no 暂停.
 * The real one has TWO closed, not-won stages with identical metadata -- 暂停 then 输单 -- and that pair
 * is what the Lost rule has to get right.
 *
 * Two arrays are SHUFFLED on purpose (HubSpot returns them in displayOrder): Sales Pipeline lists its
 * second Won-bucket stage first -- Trustpilot, whose NUMERIC id also enumerates first in a JS object --
 * and SF-Sales lists 暂停 LAST and 输单 first. Anything that took "first" or "last" from array or key
 * order instead of displayOrder picks a wrong stage. SF-Maint and SF-Train keep the API's own order.
 *
 * PARTIAL is the one SYNTHETIC pipeline (its id is not a real one, so its labels fall back to its own
 * name): one open stage and a won stage, no lost, so some labels have nowhere to go.
 */
export const SALES = "default";
export const SF_SALES = "551f4f6c-ced0-4069-b1be-f0d3dc33bf2d";
export const SF_MAINT = "d10159b0-bab4-487a-a11f-55f3a682a170";
export const SF_TRAIN = "08554d8d-265d-4fbf-94e2-7002cb1ecbca";
export const SHARED = "81ee3345-1b0f-42aa-9e78-580614546602";
export const PARTIAL = "test-partial-pipeline";

/** Sales Pipeline's post-sale step: closed at probability 1, so Won-bucket, AFTER Closed Won. */
export const TRUSTPILOT = "2831885024";

/** Salesforce - Sales, measured. s1..s6 are "1 共同利益 MI" .. "6 承诺 Commit". */
export const SF = {
  s1: "833608d9-3cbb-4bae-93a0-d0d1bf6c1064",
  s2: "c681256a-4c4d-4812-badb-1a881e35ac15",
  s3: "0ecadb3e-5eed-49fe-a44d-5bc1e7b2d472",
  s4: "cf4caa67-23c1-44f4-87d5-babf2b8f608b",
  s5: "e8b2fc64-8f3a-4e76-96a8-3bae35d2eb35",
  s6: "431cdbce-3843-4014-a396-cd504217e16a",
  paused: "4ab750e0-1d30-4265-b680-7d21a77d5328",   // 暂停
  won: "d0e83c62-647f-4511-bc00-4b92a752c690",      // 赢单
  lost: "9f26268b-9906-4924-a999-1555079f5f39",     // 输单
} as const;
/** Salesforce - Maintenance, measured. */
export const SFM = {
  s1: "43132a6c-5315-4afe-bf5c-afefe42c83db", s3: "74db274d-1fef-42a6-ad7f-1eb4d6ea75d9",
  s5: "8162973e-5d3a-4380-95b5-4685a0fe31a7", paused: "aacba166-43bc-45cf-8724-3df56d866d37",
  won: "ea1194fc-eb54-498a-84b2-599a07add210", lost: "1e88ff0a-b050-4c7d-97cb-f2570f20c1ee",
} as const;
/** Salesforce - 赋能培训, measured. */
export const SFT = {
  s1: "3ff79e92-a4c4-48e9-9b11-eb26419be1ab", s3: "c9f319fd-b7f2-4883-ac10-8885006a13e4",
  s5: "69e23107-3baf-46d6-a745-b0aea3b3c863", paused: "47f86dc8-fc4c-40af-aef5-6aeac9884115",
  won: "cd8b9086-9983-4f82-bdf0-83dfd3fd96ef", lost: "27d2ba6f-5bcc-4679-832f-1c34e8c53438",
} as const;

const open = (p: string) => ({ isClosed: "false", probability: p });
const WON = { isClosed: "true", probability: "1.0" };
const LOST = { isClosed: "true", probability: "0.0" };    // 暂停 and 输单 alike: metadata cannot tell them apart

export const PIPELINES = [
  {
    id: SALES, label: "Sales Pipeline", stages: [
      { id: TRUSTPILOT, label: "Trustpilot邀约评价（已成交）", displayOrder: 7, metadata: WON },
      { id: "appointmentscheduled", label: "Appointment Scheduled", displayOrder: 0, metadata: open("0.2") },
      { id: "qualifiedtobuy", label: "Qualified To Buy", displayOrder: 1, metadata: open("0.4") },
      { id: "presentationscheduled", label: "Presentation Scheduled", displayOrder: 2, metadata: open("0.6") },
      { id: "decisionmakerboughtin", label: "Decision Maker Bought-In", displayOrder: 3, metadata: open("0.8") },
      { id: "contractsent", label: "Contract Sent", displayOrder: 4, metadata: open("0.9") },
      { id: "closedwon", label: "Closed Won", displayOrder: 5, metadata: WON },
      { id: "closedlost", label: "Closed Lost", displayOrder: 6, metadata: LOST },
    ],
  },
  {
    id: SF_SALES, label: "Salesforce - Sales", stages: [
      { id: SF.lost, label: "输单", displayOrder: 17, metadata: LOST },
      { id: SF.s3, label: "3 验证 Validate", displayOrder: 9, metadata: open("0.4") },
      { id: SF.won, label: "赢单", displayOrder: 16, metadata: WON },
      { id: SF.s1, label: "1 共同利益 MI", displayOrder: 7, metadata: open("0.1") },
      { id: SF.s6, label: "6 承诺 Commit", displayOrder: 12, metadata: open("0.9") },
      { id: SF.s2, label: "2 探索 Discover", displayOrder: 8, metadata: open("0.2") },
      { id: SF.s5, label: "5 决定 Decide", displayOrder: 11, metadata: open("0.8") },
      { id: SF.s4, label: "4 选择 Select", displayOrder: 10, metadata: open("0.6") },
      { id: SF.paused, label: "暂停", displayOrder: 13, metadata: LOST },
    ],
  },
  {
    id: SF_MAINT, label: "Salesforce - Maintenance", stages: [
      { id: SFM.s1, label: "1 共同利益 MI", displayOrder: 7, metadata: open("0.1") },
      { id: "d5366674-cae2-4fa2-bbef-66397b045c43", label: "2 探索 Discover", displayOrder: 8, metadata: open("0.2") },
      { id: SFM.s3, label: "3 验证 Validate", displayOrder: 9, metadata: open("0.4") },
      { id: "75ab47dd-897e-4634-8870-3a279a9bb5a4", label: "4 选择 Select", displayOrder: 10, metadata: open("0.6") },
      { id: SFM.s5, label: "5 决定 Decide", displayOrder: 11, metadata: open("0.8") },
      { id: "a01226cb-d323-4aea-99e7-7cf983c4ceba", label: "6 承诺 Commit", displayOrder: 12, metadata: open("0.9") },
      { id: SFM.paused, label: "暂停", displayOrder: 13, metadata: LOST },
      { id: SFM.won, label: "赢单", displayOrder: 16, metadata: WON },
      { id: SFM.lost, label: "输单", displayOrder: 17, metadata: LOST },
    ],
  },
  {
    id: SF_TRAIN, label: "Salesforce - 赋能培训", stages: [
      { id: SFT.s1, label: "1 共同利益 MI", displayOrder: 0, metadata: open("0.1") },
      { id: "bd945ac3-1680-441e-ab07-3a72a4210387", label: "2 探索 Discover", displayOrder: 1, metadata: open("0.2") },
      { id: SFT.s3, label: "3 验证 Validate", displayOrder: 2, metadata: open("0.4") },
      { id: "5f149d6d-551f-40ef-be65-7bc2ed62fbd8", label: "4 选择 Select", displayOrder: 3, metadata: open("0.6") },
      { id: SFT.s5, label: "5 决定 Decide", displayOrder: 4, metadata: open("0.8") },
      { id: "f9c59c83-6414-4e3d-b415-c027c7a4c30e", label: "6 承诺 Commit", displayOrder: 5, metadata: open("0.9") },
      { id: SFT.paused, label: "暂停", displayOrder: 6, metadata: LOST },
      { id: SFT.won, label: "赢单", displayOrder: 7, metadata: WON },
      { id: SFT.lost, label: "输单", displayOrder: 8, metadata: LOST },
    ],
  },
  {
    id: SHARED, label: "HubSpot Shared Selling Pipeline", stages: [
      { id: "deal_registration_discovery", label: "Discovery", displayOrder: 0, metadata: open("0.2") },
      { id: "deal_registration_Solution Demo", label: "Solution Demo", displayOrder: 1, metadata: open("0.3") },
      { id: "deal_registration_Business Considerations", label: "Business Considerations", displayOrder: 2, metadata: open("0.3") },
      { id: "deal_registration_Pricing and Terms", label: "Pricing and Terms", displayOrder: 3, metadata: open("0.6") },
      { id: "deal_registration_Out for Signature", label: "Out for Signature", displayOrder: 4, metadata: open("0.9") },
      { id: "deal_registration_closed_lost", label: "Closed Lost", displayOrder: 5, metadata: LOST },
      { id: "deal_registration_closed_won", label: "Closed Won", displayOrder: 6, metadata: WON },
    ],
  },
  {
    id: PARTIAL, label: "Partial Pipeline (synthetic)", stages: [
      { id: "partial_open", label: "Open", displayOrder: 0, metadata: open("0.1") },
      { id: "partial_won", label: "Won", displayOrder: 1, metadata: { isClosed: "true", isClosedWon: "true", probability: "1.0" } },
    ],
  },
];

/** What each label must resolve to: the first stage of its bucket by displayOrder -- the LAST for Lost. */
export const EXPECTED_TARGETS: Record<string, Record<string, string>> = {
  [SALES]: { New: "appointmentscheduled", Proposal: "presentationscheduled", Negotiation: "contractsent",
    Won: "closedwon", Lost: "closedlost" },
  [SF_SALES]: { New: SF.s1, Proposal: SF.s3, Negotiation: SF.s5, Won: SF.won, Lost: SF.lost },
  [SF_MAINT]: { New: SFM.s1, Proposal: SFM.s3, Negotiation: SFM.s5, Won: SFM.won, Lost: SFM.lost },
  [SF_TRAIN]: { New: SFT.s1, Proposal: SFT.s3, Negotiation: SFT.s5, Won: SFT.won, Lost: SFT.lost },
  [SHARED]: { New: "deal_registration_discovery", Proposal: "deal_registration_Business Considerations",
    Negotiation: "deal_registration_Out for Signature", Won: "deal_registration_closed_won",
    Lost: "deal_registration_closed_lost" },
  [PARTIAL]: { New: "partial_open", Won: "partial_won" },
};

/** A stage that is in each bucket but is NOT the label's target: "already there" must send nothing. */
export const IN_BUCKET_NOT_TARGET: Record<string, Record<string, string>> = {
  [SALES]: { New: "qualifiedtobuy", Proposal: "decisionmakerboughtin", Won: TRUSTPILOT },
  [SF_SALES]: { New: SF.s2, Proposal: SF.s4, Negotiation: SF.s6, Lost: SF.paused },
};

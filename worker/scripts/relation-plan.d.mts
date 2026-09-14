/** Types for the historical relation planner. See relation-plan.mjs for the reasoning. */

export declare const WRITE: "write";
export declare const ALREADY_CORRECT: "alreadyCorrect";
export declare const CAPPED: "capped";
export declare const NO_ACCOUNT_CARD: "noAccountCard";

export interface RelationPlan {
  /** What the relation cell WILL CONTAIN — the write replaces, it does not append. Always a superset
   *  of `linked`: this pass is additive-only and never removes a link. */
  want: string[];
  outcome: "write" | "alreadyCorrect" | "capped" | "noAccountCard";
  /** Only the genuinely new links, i.e. the ones charged against the ceiling. */
  added: string[];
  /** HubSpot company ids skipped because their Accounts card is at the link ceiling. */
  capped: string[];
  /** HubSpot company ids with no Accounts card on the board. */
  missing: string[];
  /** Existing links no current HubSpot association accounts for. Reported, never acted on. */
  extra: string[];
}

export declare function planContactLinks(args: {
  companyIds: string[];
  linked: string[];
  /** monday item id -> links that cell holds. MUTATED on write. */
  counts: Map<string, number>;
  /** HubSpot company id -> Accounts card item ids. */
  accounts: Map<string, string[]>;
  ceiling: number;
}): RelationPlan;

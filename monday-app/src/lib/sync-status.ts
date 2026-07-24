export type SyncStatus = "syncing" | "synced" | "error";

/** Shared drawer→board contract for a completed monday save whose HubSpot sync runs in the background. */
export interface SavedInfo { itemId: string; isEdit: boolean; clearProps: string[] }

/** "Synced" is only truthful when the Worker reported success AND a HubSpot Deal ID now exists.
 * Anything else is "error" (shown as Retry) — never a false Synced. */
export function confirmSynced(syncOk: boolean, hubspotId?: string): SyncStatus {
  return syncOk && !!hubspotId ? "synced" : "error";
}

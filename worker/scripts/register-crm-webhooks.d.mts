/** Types for the CRM monday-webhook registrar. The script itself is plain .mjs so it can be run with
 *  `node` directly; this declaration exists so the test suite (and tsc) can import its constants. */

export declare const CRM_BOARDS: Record<string, string>;

/** REGISTRATION event names. `create_item` is registered but DELIVERED as `create_pulse`. */
export declare const CRM_WEBHOOK_EVENTS: string[];

/** Registration name -> the payload `event.type` values monday actually delivers for it. */
export declare const DELIVERED_EVENT_ALIASES: Record<string, string[]>;

export interface MondayWebhook {
  id: string;
  event: string;
  board_id?: string;
  config?: string | null;
}

export declare function existingHooks(token: string, boardId: string): Promise<MondayWebhook[]>;

/** Which of CRM_WEBHOOK_EVENTS have no matching hook yet — the basis of idempotent registration. */
export declare function missingEvents(hooks: MondayWebhook[], url: string): string[];

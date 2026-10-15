/** Types for the CRM app's webhook-subscription reader, used by the mapped-vs-subscribed test. */

export interface CrmSubscription {
  subscriptionType: string;
  objectType: string;
  propertyName?: string;
  active?: boolean;
}

export interface Subscriptions {
  targetUrl: string;
  all: CrmSubscription[];
  /** Property names carrying an object.propertyChange subscription for this object type. */
  propsFor(objectType: string): string[];
  /** Non-property subscription types (creation / deletion / associationChange) for this object type. */
  typesFor(objectType: string): string[];
}

export declare function readSubscriptions(): Subscriptions;

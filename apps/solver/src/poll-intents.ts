import type { rpc } from "@stellar/stellar-sdk";
import { decodeSorobanEvents } from "@xebra/chain-adapters";
import type { IntentV2 } from "@xebra/intent-schema";
import { intentFromChainEvent } from "./decode-intent-event.js";

/**
 * Finds new `IntentOpened` events by asking Soroban RPC directly, so the solver runs as one
 * process with no event bus and no database. Same decoder as apps/indexer-stellar, so the two
 * cannot read an event differently. Cursor-based and testable with an injected source, like the
 * indexers' poll functions.
 */
export interface IntentEventSource {
  getEvents(cursor: string | undefined): Promise<rpc.Api.GetEventsResponse>;
}

export interface OpenedIntent {
  intentHash: string;
  intent: IntentV2;
  txRef: string;
}

export interface PollResult {
  intents: OpenedIntent[];
  /** Pass back in on the next call. Unchanged when nothing new arrived. */
  cursor: string | undefined;
  /** False when this page was empty, i.e. the solver has caught up. */
  more: boolean;
}

export async function pollOpenedIntentsOnce(
  source: IntentEventSource,
  cursor: string | undefined,
): Promise<PollResult> {
  const response = await source.getEvents(cursor);

  const intents: OpenedIntent[] = [];
  for (const event of decodeSorobanEvents(response.events)) {
    const intent = intentFromChainEvent(event);
    if (!intent || !event.intentHash) continue;
    intents.push({ intentHash: event.intentHash, intent, txRef: event.txRef ?? "" });
  }

  // `||`: an empty cursor means no progress, not "start over".
  return { intents, cursor: response.cursor || cursor, more: response.events.length > 0 };
}

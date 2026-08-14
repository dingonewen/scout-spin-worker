import type { TicketEventEnvelope } from "../contract/envelope";
import type { IngestEnvelopeResponse } from "../contract/ingest";
import type { ScoutCaseContext } from "../contract/scout-context";
import type { TicketApiClient } from "../api-client";
import type { Classifier } from "../classifier/interface";
import { normalizeTicketDecision } from "../classifier/normalize";
import { prefilterDecisions } from "../classifier/prefilter";
import { channelForMessage } from "./channel";

/**
 * The email the worker receives. In the real deployment the Cloudflare email
 * worker classifies the sender and persists the message first, yielding a
 * resolved orgId + threadId + message id; those are the inputs here. The mock
 * resolves threadId/orgId from a fixture.
 */
export type InboundEmail = {
  messageId: string;
  threadId: string;
  orgId: string;
  subject: string;
  body: string;
  from: string;
  to?: string;
  receivedAt?: string;
  channel?: TicketEventEnvelope["channel"];
};

export type PipelineDeps = {
  classifier: Classifier;
  api: TicketApiClient;
};

export type PipelineResult = {
  envelope: TicketEventEnvelope;
  response: IngestEnvelopeResponse;
};

/**
 * The whole ticket-handling path, expressed as pure orchestration over two
 * injected dependencies — the swappable classifier and the ticket API client.
 * This is what the Spin HTTP adapter calls, and what the plain-Node demo
 * exercises directly (no Spin, no live LLM).
 *
 *   1. load case context      (tickets.scoutCaseContext)
 *   2. locate current message
 *   3. derive channel
 *   4. deterministic prefilter (no_ticket / inbound whole_po_rejection)
 *   5. classify               → EnvelopeDecision[]
 *   6. normalize identifiers  (PO header safety gate, SOR parity)
 *   7. POST the envelope      (tickets.ingestEnvelope)  ← the only write
 *
 * The worker deliberately does NOT resolve scopes, build proposals, or dedup —
 * all of that is the API's job, inside its own transaction.
 */
export async function runTicketPipeline(
  email: InboundEmail,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const context: ScoutCaseContext = await deps.api.scoutCaseContext({
    orgId: email.orgId,
    threadId: email.threadId,
    currentMessageId: email.messageId,
  });

  const currentMessage = context.messages.find((m) => m.providerMessageId === email.messageId);
  if (!currentMessage) {
    throw new Error(`Message ${email.messageId} was not found in the case context for thread ${email.threadId}.`);
  }

  const channel = email.channel ?? channelForMessage(context, currentMessage);

  let decisions = prefilterDecisions({ context, currentMessage, channel });
  if (decisions === null) {
    decisions = await deps.classifier.classify({ context, currentMessage, channel });
  }
  decisions = decisions.map((decision) => normalizeTicketDecision(decision, context));

  const envelope: TicketEventEnvelope = {
    providerEventId: email.messageId,
    channel,
    erpEventIds: [],
    decisions,
  };

  const response = await deps.api.ingestEnvelope(envelope);
  return { envelope, response };
}

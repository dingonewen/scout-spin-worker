// ---------------------------------------------------------------------------
// The ticket API ingest contract — the boss's target contract:
//
//     input  = email message
//     output = call to the ticket API
//
// The Spin worker classifies an email into a TicketEventEnvelope, POSTs it to
// `tickets.ingestEnvelope`, and the API (the single trust boundary) resolves
// scopes, builds ticket proposals, dedups, and commits with a txid. This file
// pins the request/response shapes so the mock API and the real API implement
// the same surface.
//
// NOTE: `tickets.ingestEnvelope` + `tickets.scoutCaseContext` do NOT exist in
// the SOR API yet — they are the two procedures the prototype's boundary
// implies. The mock here implements them; wiring the real API is a follow-up
// on the SOR side (out of scope for this repo).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { TicketEventEnvelopeSchema } from "./envelope";

export const IngestEnvelopeRequestSchema = TicketEventEnvelopeSchema;
export type IngestEnvelopeRequest = z.infer<typeof IngestEnvelopeRequestSchema>;

export const IngestOutcomeSchema = z.object({
  /** Index into request.decisions — one outcome per decision. */
  decisionIndex: z.number().int().nonnegative(),
  kind: z.string(),
  outcome: z.string(),
  ticketId: z.string().nullable(),
});

export const IngestEnvelopeResponseSchema = z.object({
  txid: z.string(),
  outcomes: z.array(IngestOutcomeSchema),
  ticketIds: z.array(z.string()),
});

export type IngestEnvelopeResponse = z.infer<typeof IngestEnvelopeResponseSchema>;

export const ScoutCaseContextRequestSchema = z.object({
  orgId: z.string().min(1),
  threadId: z.string().min(1),
  currentMessageId: z.string().min(1),
});

export type ScoutCaseContextRequest = z.infer<typeof ScoutCaseContextRequestSchema>;

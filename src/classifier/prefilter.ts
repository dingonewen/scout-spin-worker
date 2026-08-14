import type { EnvelopeDecision } from "../contract/envelope";
import type { ClassifyInput } from "./interface";
import { decideTicketLocally } from "./local";

// ---------------------------------------------------------------------------
// Deterministic prefilter — the cheap fast path that only short-circuits the
// outcomes that are SAFE to decide without the LLM:
//
//   - no_ticket: clearly non-procurement traffic (a wrong no_ticket is cheap
//     to fix, a wrong po_creation is not).
//   - whole_po_rejection on an inbound supplier message: an explicit,
//     unambiguous rejection is a direct business fact that stale PO/line state
//     must not let the model reinterpret as an acknowledgement.
//
// Everything else returns null and the LLM stays the authority. This mirrors
// SOR's decideTicketEnvelope short-circuits, which call decideTicketLocally and
// only take its verdict for those two kinds — the remaining local reads
// (partial ack, line_exception, asn, …) are computed but discarded in favour of
// the contextual agent. The no-API-key fallback is the same local classifier
// surfaced explicitly as LocalClassifier (local-classifier.ts).
// ---------------------------------------------------------------------------

export function prefilterDecisions(input: ClassifyInput): EnvelopeDecision[] | null {
  const local = decideTicketLocally(input.context, input.currentMessage);
  if (local.kind === "no_ticket") return [local];
  if (local.kind === "whole_po_rejection" && input.currentMessage.direction === "inbound") return [local];
  return null; // defer to the LLM
}

import type { EnvelopeDecision } from "../contract/envelope";
import type { ClassifyInput } from "./interface";
import { decideTicketLocally, isNewOutboundPoRoot } from "./local";

// ---------------------------------------------------------------------------
// Deterministic prefilter — the cheap fast path that only short-circuits the
// outcomes that are SAFE to decide without the LLM. It mirrors the short-
// circuit ladder in SOR's `decideTicketEnvelope` (ticket-agent.ts), in the
// same order:
//
//   - outbound buyer mail that is not a recognized new-PO root: a buyer's own
//     outbound mail must never become a supplier-response ticket. scout_cc →
//     triage for human review; the buyer_cc mailbox copy → no_ticket.
//   - whole_po_rejection on an inbound supplier message: an explicit,
//     unambiguous rejection is a direct business fact that stale PO/line state
//     must not let the model reinterpret as an acknowledgement.
//   - no_ticket: clearly non-procurement traffic (a wrong no_ticket is cheap
//     to fix, a wrong po_creation is not).
//
// Everything else returns null and the LLM stays the authority. The remaining
// local reads (partial ack, line_exception, asn, …) are computed but discarded
// in favour of the contextual agent. The no-API-key fallback is the same local
// classifier surfaced explicitly as LocalClassifier (local-classifier.ts).
// ---------------------------------------------------------------------------

export function prefilterDecisions(input: ClassifyInput): EnvelopeDecision[] | null {
  const local = decideTicketLocally(input.context, input.currentMessage);
  const { currentMessage: current, channel } = input;

  // [A] outbound buyer-mail guard — decideTicketEnvelope's first check.
  if (current.direction === "outbound" && !isNewOutboundPoRoot(input.context, current)) {
    if (channel === "scout_cc") {
      return [{
        ...local,
        kind: "triage",
        confidence: 0.6,
        reason: "Buyer mail to the Scout address is not a recognized procurement scenario; routed to triage for human review.",
        affectedPartCodes: [],
        rejectionReason: null,
        modifications: [],
        purchaseOrder: null,
      }];
    }
    return [{
      ...local,
      kind: "no_ticket",
      confidence: 1,
      reason: "The current message is buyer-originated context for an existing PO and does not itself represent a supplier response.",
      affectedPartCodes: [],
      rejectionReason: null,
      modifications: [],
      purchaseOrder: null,
    }];
  }

  // [B] inbound rejection short-circuit.
  if (current.direction === "inbound" && local.kind === "whole_po_rejection") return [local];

  // [C] noise short-circuit.
  if (local.kind === "no_ticket") return [local];

  return null; // defer to the LLM
}

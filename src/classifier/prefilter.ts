import type { EnvelopeDecision } from "../contract/envelope";
import type { ClassifyInput } from "./interface";

// ---------------------------------------------------------------------------
// Deterministic prefilter — the cheap fast path that only ever emits
// no_ticket, and only when it is confident. Anything ambiguous returns null
// so the LLM stays the authority.
//
// This is a deliberate MINIMAL port. The SOR worker also carries a ~600-line
// regex fallback (decideTicketLocally) and dedicated ASN/NDR extractors in
// ticket-agent.ts; port those for full offline parity if the A/B needs the
// LLM-less baseline. Do not let this prefilter emit a *positive* classification
// — a wrong no_ticket is cheap to fix, a wrong po_creation is not.
// ---------------------------------------------------------------------------

const PROCUREMENT_SIGNAL =
  /\b(po[-\s#:]?[a-z0-9][a-z0-9-]{2,}|purchase order|acknowledge|acknowledged|shipped|shipment|asn|tracking|exception|counter|reject|need[- ]by|delivery)\b/i;

export function prefilterDecisions(input: ClassifyInput): EnvelopeDecision[] | null {
  const text = `${input.currentMessage.subject}\n${input.currentMessage.bodyText ?? ""}`;

  // Clearly non-procurement traffic (bounced/auto replies, signatures, etc.)
  // with no PO reference and no procurement vocabulary → no_ticket.
  if (!PROCUREMENT_SIGNAL.test(text) && input.context.purchaseOrders.length === 0) {
    return [{
      kind: "no_ticket",
      confidence: 1,
      reason: "No procurement signal and no purchase orders on file; routed to no_ticket by the deterministic prefilter.",
    }];
  }

  return null; // defer to the LLM
}

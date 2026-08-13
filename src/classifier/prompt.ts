import type { ClassifyInput } from "./interface";

// ---------------------------------------------------------------------------
// Classification prompt. Ported in spirit from
// packages/email-worker/src/tickets/ticket-agent.ts (the scoutAgent's system
// prompt + the EnvelopeDecisionsSchema it emits). Tune for F1 parity against
// the same fixtures before the A/B run — the schema and the five kinds below
// are the contract; the prose is free to change.
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You classify an inbound procurement email into zero or more ticket
decisions for a purchase-order system of record (SOR).

You respond with ONLY a JSON object of the shape:
{"decisions": [ {decision}, ... ]}

Each decision describes ONE purchase order (PO) and ONE intent. Emit one
decision per (PO, intent). When the email is not actionable procurement
traffic, emit a single no_ticket decision.

Decision fields:
- kind: one of the kinds below.
- poCode: the PO number as written (e.g. "PO-2026-1001"), or null.
- supplierCode: the supplier code if stated, else null.
- supplierName: supplier display name, else null.
- confidence: 0.0 to 1.0.
- reason: one sentence explaining the classification.
- affectedPartCodes: part codes the decision touches (empty = whole PO).
- rejectionReason: for rejections; else null.
- modifications: [{partCode, field, proposedValue, reason}] where field is one
  of "promised_date" | "quantity" | "unit_price".
- purchaseOrder: for po_creation only — {poCode, supplierCode, supplierName,
  orderDate, lines:[{partCode, partName, partSpec, quantity, unitPrice, needBy}]}.
- payload: kind-specific facts (see asn below).

The five kinds you must detect:

1. po_creation — the email creates a brand-new PO (usually a buyer sending a
   new order to a supplier). Populate purchaseOrder with header + all lines.

2. full_acknowledgement — the supplier acknowledges the ENTIRE PO. Set poCode,
   leave affectedPartCodes empty.

3. partial_acknowledgement — the supplier acknowledges SOME lines. Set poCode
   and affectedPartCodes to exactly the acknowledged part codes.

4. line_exception — the supplier raises a post-acknowledgement exception and
   proposes a counter-offer on one or more lines. Set poCode, affectedPartCodes,
   and modifications[] with the counter-proposed field/value per line.

5. asn — the supplier sends an advance shipping notice. Set poCode and
   payload = { shipDate, carrier, trackingNumber, expectedDelivery,
   lines: [{partCode, quantityShipped}] }.

Anything else (no PO, chit-chat, signatures, out-of-scope requests) →
one decision: {"kind":"no_ticket", "confidence":1.0, "reason":"..."}.`;
}

export function buildUserPrompt(input: ClassifyInput): string {
  const { context, currentMessage } = input;
  const poLines = context.purchaseOrders
    .map((po) => {
      const lines = po.lines
        .map((l) => `    - ${l.partCode ?? "?"} qty ${l.quantity} @ ${l.unitPrice ?? "?"} · status ${l.status}`)
        .join("\n");
      return `  PO ${po.poCode} (${po.poId}) · supplier ${po.supplierCode ?? "?"} · status ${po.status}\n${lines}`;
    })
    .join("\n");

  return `THREAD
subject: ${context.thread.subject}
messageCount: ${context.thread.messageCount}

KNOWN PURCHASE ORDERS
${poLines || "  (none on file)"}

CURRENT EMAIL
from: ${currentMessage.from.map((p) => p.email).join(", ")}
to: ${currentMessage.to.map((p) => p.email).join(", ")}
subject: ${currentMessage.subject}
body:
${currentMessage.bodyText ?? "(empty)"}

Classify the CURRENT EMAIL against the known purchase orders.`;
}

// ---------------------------------------------------------------------------
// Envelope contract — a faithful, self-contained re-declaration of the SOR
// ingestion envelope (packages/email-worker/src/tickets/event-envelope.ts).
//
// This is the ONE handshake surface between the Spin worker and the ticket
// API. It is duplicated here (not imported from @acme/shared) so this
// prototype compiles without pulling in the SOR workspace — but it must NOT
// drift. If the SOR schema changes, update this file in the same change.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ScoutCaseContext } from "./scout-context";

export const ModificationSchema = z.object({
  partCode: z.string().nullable(),
  field: z.enum(["promised_date", "quantity", "unit_price"]),
  proposedValue: z.union([z.string(), z.number()]),
  reason: z.string().nullable(),
});

export const PurchaseOrderSchema = z.object({
  poCode: z.string(),
  // Models emit null when the document does not print a machine supplier
  // code; the server derives it from the counterparty when absent.
  supplierCode: z.preprocess((value) => value ?? "", z.string()),
  supplierName: z.string(),
  orderDate: z.string().nullable(),
  lines: z.array(z.object({
    partCode: z.string(),
    partName: z.string().nullable(),
    partSpec: z.string().nullable(),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative(),
    needBy: z.string().nullable(),
  })),
});

/**
 * One decision = one (PO, intent). `kind` is the ticket kind key
 * (e.g. "full_acknowledgement"). `poId` is null for po_creation / triage /
 * no_ticket and is otherwise resolved server-side from `poCode` against the
 * authoritative case context — the worker never asserts a poId the API does
 * not re-derive.
 */
// `.default(...)` only fills a *missing* (`undefined`) key — but LLMs often
// emit an explicit `null` for the object/array fields they'd rather omit
// (`payload` in particular). Coerce `null` → the default so one stray null
// doesn't fail the whole envelope. `kind` / `reason` / `confidence` stay
// strict: they are required and the prompt always asks for them.
export const EnvelopeDecisionSchema = z.object({
  kind: z.string().min(1),
  poId: z.string().nullable().default(null),
  poCode: z.string().nullable().default(null),
  supplierCode: z.string().nullable().default(null),
  affectedPoCodes: z.preprocess((value) => value ?? [], z.array(z.string())),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  supplierName: z.string().nullable().default(null),
  affectedPartCodes: z.preprocess((value) => value ?? [], z.array(z.string())),
  rejectionReason: z.string().nullable().default(null),
  modifications: z.preprocess((value) => value ?? [], z.array(ModificationSchema)),
  purchaseOrder: PurchaseOrderSchema.nullable().default(null),
  payload: z.preprocess((value) => value ?? {}, z.record(z.string(), z.unknown())),
});

export type EnvelopeDecision = z.infer<typeof EnvelopeDecisionSchema>;

/** The agent-facing output shape: the model emits decisions only. */
export const EnvelopeDecisionsSchema = z.object({
  decisions: z.array(EnvelopeDecisionSchema).default([]),
});

export const INGESTION_CHANNELS = [
  "buyer_cc",
  "scout_cc",
  "supplier_direct",
  "erp_api",
  "scheduled_scan",
  "ndr",
  "csv_drop",
] as const;

export const TicketEventEnvelopeSchema = z.object({
  /** Raw idempotency key — provider message-id (processed_messages key). */
  providerEventId: z.string().min(1),
  channel: z.enum(INGESTION_CHANNELS),
  erpEventIds: z.array(z.string()).default([]),
  decisions: z.array(EnvelopeDecisionSchema).default([]),
});

export type TicketEventEnvelope = z.infer<typeof TicketEventEnvelopeSchema>;

const PO_NULL_KINDS = new Set(["no_ticket", "triage", "po_creation", "leadtime_check"]);

export function decisionCarriesPoScope(kind: string) {
  return !PO_NULL_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Scope resolution (ported verbatim from event-envelope.ts, crypto-free so it
// runs in the Spin JS runtime). In the real deployment the API re-runs this
// server-side as the authoritative pass; the worker's copy exists so the
// mock/API can downgrade un-bindable decisions to triage and so the prototype
// can validate locally. The semantic-hash dedup is deliberately NOT ported —
// it lives in the API's ingest transaction (and needs node:crypto).
// ---------------------------------------------------------------------------

export function resolveEnvelopeScopes(
  context: ScoutCaseContext,
  envelope: TicketEventEnvelope,
): TicketEventEnvelope {
  return {
    ...envelope,
    decisions: envelope.decisions.map((decision) => resolveDecisionScope(context, decision)),
  };
}

export function resolveDecisionScope(
  context: ScoutCaseContext,
  decision: EnvelopeDecision,
): EnvelopeDecision {
  if (decision.kind === "no_ticket" || decision.kind === "triage") {
    return { ...decision, poId: null };
  }
  if (decision.kind === "po_creation") {
    if (!decision.purchaseOrder || decision.purchaseOrder.lines.length === 0) {
      return downgradeToTriage(decision, "The new-PO decision did not contain enough validated header and line data to propose inserts.");
    }
    return { ...decision, poId: null };
  }
  if (decision.kind === "leadtime_check") {
    if (!decision.supplierCode) {
      return downgradeToTriage(decision, "The supplier-scoped lead-time decision lacked a supplier code.");
    }
    return { ...decision, poId: null };
  }
  const po = matchDecisionPo(context, decision);
  if (!po) {
    return downgradeToTriage(
      decision,
      `No existing SOR purchase order could be safely matched to ${decision.poCode ?? "the decision"}.`,
    );
  }
  return { ...decision, poId: po.poId, poCode: po.poCode };
}

export function matchDecisionPo(
  context: ScoutCaseContext,
  decision: EnvelopeDecision,
): ScoutCaseContext["purchaseOrders"][number] | null {
  if (decision.poId) {
    const byId = context.purchaseOrders.find((po) => po.poId === decision.poId);
    if (byId) return byId;
  }
  if (decision.poCode) {
    const byCode = context.purchaseOrders.find((po) => po.poCode === decision.poCode);
    if (byCode) return byCode;
  }
  return context.purchaseOrders.length === 1 ? (context.purchaseOrders[0] ?? null) : null;
}

function downgradeToTriage(decision: EnvelopeDecision, reason: string): EnvelopeDecision {
  return {
    ...decision,
    kind: "triage",
    poId: null,
    confidence: Math.min(decision.confidence, 0.79),
    reason: `${decision.reason} ${reason}`,
    purchaseOrder: null,
  };
}

/** The affected-part scope, uppercased + deduped — for the mock's survival test. */
export function coveredPartCodes(decision: EnvelopeDecision | null) {
  if (!decision) return [];
  return [...new Set(decision.affectedPartCodes
    .map((partCode) => partCode.trim().toUpperCase())
    .filter(Boolean))];
}

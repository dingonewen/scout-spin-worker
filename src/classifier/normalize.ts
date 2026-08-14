import type { EnvelopeDecision } from "../contract/envelope";
import type { ScoutCaseContext } from "../contract/scout-context";
import { clean, escapeRegex, findPoCode } from "./text";

// ---------------------------------------------------------------------------
// Identifier normalization — a direct port of SOR's `normalizeTicketDecision`
// (packages/email-worker/src/tickets/ticket-agent.ts). It keeps model
// extraction useful while enforcing identifiers the SOR can safely persist:
// a decision whose PO header is missing a safe PO number, supplier name, or
// supplier code is downgraded to triage rather than persisted. Pure, Spin-safe.
// ---------------------------------------------------------------------------

/**
 * Canonicalize a decision's PO header + part codes. Applied to every decision
 * (local and LLM) before the envelope leaves the worker, mirroring the
 * normalizing pass in SOR's decideTicketEnvelope.
 */
export function normalizeTicketDecision(input: EnvelopeDecision, context?: ScoutCaseContext): EnvelopeDecision {
  if (!input.purchaseOrder) return input;
  const envelopeSupplier = context ? supplierFromEnvelope(context) : null;
  const supplierName = clean(input.purchaseOrder.supplierName) ?? clean(input.supplierName) ?? envelopeSupplier?.name ?? null;
  const supplierCode = clean(input.purchaseOrder.supplierCode)
    ?? clean(input.supplierCode)
    ?? envelopeSupplier?.code
    ?? (supplierName ? supplierName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") : null);
  const poCode = findPoCode(input.purchaseOrder.poCode) ?? findPoCode(input.poCode ?? "");
  if (!supplierCode || !supplierName || !poCode) {
    return {
      ...input,
      kind: "triage",
      confidence: Math.min(input.confidence, 0.79),
      reason: `${input.reason} The PO header is missing a safe PO number, supplier name, or supplier code.`,
      purchaseOrder: null,
    };
  }
  return {
    ...input,
    poCode,
    supplierCode,
    supplierName,
    purchaseOrder: {
      ...input.purchaseOrder,
      poCode,
      supplierCode,
      supplierName,
      lines: input.purchaseOrder.lines.map((line) => normalizeLine(line)),
    },
  };
}

function supplierFromEnvelope(context: ScoutCaseContext) {
  const current = context.messages.find((message) => message.id === context.currentMessageId);
  const candidates = current?.direction === "outbound" ? current.to : current?.from;
  const counterparty = candidates?.find((person) => person.email?.trim());
  if (!counterparty?.email) return null;
  const emailLocal = counterparty.email.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  const name = clean(counterparty.name) ?? clean(emailLocal);
  if (!name) return null;
  return {
    name,
    code: name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, ""),
  };
}

function normalizeLine(line: NonNullable<EnvelopeDecision["purchaseOrder"]>["lines"][number]) {
  const raw = line.partCode.trim();
  const candidates = raw.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]{1,})+\b/gi) ?? [];
  const canonical = candidates.at(-1)?.toUpperCase() ?? raw.toUpperCase();
  const derivedName = canonical !== raw.toUpperCase()
    ? raw.replace(new RegExp(`[,\\s–—-]*${escapeRegex(canonical)}\\s*$`, "i"), "").trim()
    : null;
  return {
    ...line,
    partCode: canonical,
    partName: clean(line.partName) ?? clean(derivedName),
  };
}

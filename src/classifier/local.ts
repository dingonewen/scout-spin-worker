import type { EnvelopeDecision } from "../contract/envelope";
import type { ScoutCaseContext, ScoutMessage } from "../contract/scout-context";
import { findPartCodes, findPoCode, hasProcurementSignal } from "./text";

// ---------------------------------------------------------------------------
// The deterministic fallback classifier — a direct port of SOR's
// `decideTicketLocally` (packages/email-worker/src/tickets/ticket-agent.ts).
// It emits a SINGLE decision (it never splits): the LLM is the only path that
// fans out per (PO, intent). prefilter.ts uses this for the cheap, safe
// outcomes — no_ticket and an unambiguous inbound rejection — and
// local-classifier.ts exposes the whole thing as a no-key baseline.
//
// Pure regex + string work only: no node:* imports, so it runs in the Spin JS
// runtime and under plain Node alike.
// ---------------------------------------------------------------------------

type LocalDecision = Omit<EnvelopeDecision, "kind">;

export function decideTicketLocally(
  context: ScoutCaseContext,
  current?: ScoutMessage,
): EnvelopeDecision {
  const message = current ?? context.messages.find((m) => m.id === context.currentMessageId);
  const text = `${message?.subject ?? ""}\n${message?.bodyText ?? ""}`.trim();
  const lower = text.toLowerCase();
  const poCode = findPoCode(text) ?? context.purchaseOrders[0]?.poCode ?? null;
  const base: LocalDecision = {
    confidence: 0.72,
    poId: null,
    poCode,
    supplierCode: null,
    supplierName: null,
    affectedPoCodes: [],
    affectedPartCodes: findPartCodes(text),
    rejectionReason: null,
    modifications: [],
    purchaseOrder: null,
    payload: {},
    // Every branch overrides the reason; the ASN/NDR helpers read the base
    // through a full-decision-shaped parameter.
    reason: "",
  };

  // #16 — a delivery failure outranks every other reading: an NDR body quotes
  // the original message's subject, and that quoted PO must not re-classify
  // the failure as the original message's intent. Local fallback emits a
  // single decision (it never splits); the model path fans a multi-PO bounce
  // out per affected PO.
  const ndr = detectDeliveryFailure(context, text, lower);
  if (ndr) return ndr;

  if (/\b(reject(?:ed|ing)?|decline|cannot accept|unable to accept)\b/.test(lower)
    && /\b(entire|whole|all lines|purchase order|\bpo\b)\b/.test(lower)) {
    return { ...base, kind: "whole_po_rejection", confidence: 0.86, reason: "The current message rejects the complete purchase order.", rejectionReason: text.slice(0, 500) };
  }
  // ERP-originated fact family (#6/#7/#8): the wording is declarative
  // ("has been cancelled / updated"), not a supplier proposal. Supplier
  // proposals must not shadow these, so the propose/request vocabulary is
  // excluded from the update rule and falls through to pre_ack_modification.
  if (/\b(cancel(?:led|ling|lation)?)\b/.test(lower)
    && /\b(entire|entirety|whole|in full|completely|all of)\b/.test(lower)
    && /\b(purchase order|\bpo\b)\b/.test(lower)) {
    return { ...base, kind: "whole_po_cancellation", confidence: 0.85, reason: "The current message cancels the entire purchase order.", rejectionReason: text.slice(0, 500) };
  }
  if (/\b(cancel(?:led|ling|lation)?)\b/.test(lower)
    && /\b(line[s]?|item[s]?|part[s]?|qty|quantity)\b/.test(lower)) {
    return { ...base, kind: "line_cancellation", confidence: 0.84, reason: "The current message cancels one or more lines of the purchase order.", rejectionReason: text.slice(0, 500) };
  }
  const supplierProposal = /\b(propos(?:e|ed|al)|we (?:would )?(?:like|want)|requesting? (?:a )?change|need to change|instead)\b/.test(lower);
  if (!supplierProposal && /\b(updat(?:e|ed|ing)|revise[ds]?|adjust(?:ed)?|change[ds]?)\b/.test(lower)
    && /\b(quantity|qty|need[- ]by|promised date|delivery date|unit price)\b/.test(lower)
    && poCode) {
    return { ...base, kind: "line_update", confidence: 0.82, reason: "The current message updates quantity or need-by values on existing purchase order lines." };
  }
  // Post-acknowledgement responses (#9 / #15): "can no longer meet / fulfill
  // the acknowledged terms". The split is the counter — a concrete new date or
  // quantity is a line_exception; dropping the commitment with no alternative
  // is a post_ack_rejection. When the PO is in the case file and NOT
  // acknowledged, these route to the pre-ack twins instead (#4/#5) — the
  // scenario doc's loop rule. With no PO in the case file the heuristic
  // cannot know the ack state, so it proceeds.
  const casePo = poCode
    ? context.purchaseOrders.find((po) => po.poCode === poCode)
    : undefined;
  const acknowledged = casePo ? casePo.lines.some((line) => line.status === "acknowledged") : null;
  if (acknowledged !== false && /\b(no longer|can(?:'t|not)|unable to|cannot)\b/.test(lower)
    && /\b(meet|hold|fulfill|deliver|ship)\b/.test(lower)) {
    const hasCounter = /\b(quantity|qty|pieces?|units?|date|day)\b/.test(lower)
      && /\b(instead|new|move|slip|revise|shift|push|propos(?:e|ed)?|offer(?:ed)?)\b/.test(lower);
    if (hasCounter) {
      return { ...base, kind: "line_exception", confidence: 0.82, reason: "The current message is a post-acknowledgement exception carrying a counter-proposal (a new date or quantity)." };
    }
    return { ...base, kind: "post_ack_rejection", confidence: 0.82, reason: "The current message is a post-acknowledgement rejection with no counter-offer.", rejectionReason: text.slice(0, 500) };
  }
  // #13-reply wording the #9/#15 block above does not cover (batch-2 04): a
  // flagged problem ("an issue / will be late / a delay / walking back") that
  // never says "can no longer meet". The routing contract is the same — a
  // concrete counter (new date/quantity) is line_exception, walking the
  // commitment back with no counter is post_ack_rejection — but this wording
  // is gated on acknowledged lines ACTUALLY in the case file: a bare "we have
  // an issue, new date" with no acknowledged PO stays a pre-ack proposal read
  // (#4), so unlike the block above, unknown ack state does not proceed.
  const poHasAcknowledgedLines = context.purchaseOrders.some(
    (po) => po.status === "acknowledged" || po.lines.some((line) => line.status === "acknowledged"),
  );
  if (poHasAcknowledgedLines
    && /\b(walk(?:ing)? back|withdraw(?:ing)?)\b/.test(lower)
    && !/\b(new (?:date|quantity|price)|deliver(?:y)? (?:date|by)|propos(?:e|ed)|instead|reschedule|push(?:ing)? (?:out|back))\b/.test(lower)) {
    return { ...base, kind: "post_ack_rejection", confidence: 0.82, reason: "The current message walks back an acknowledged purchase order with no counter-offer.", rejectionReason: text.slice(0, 500) };
  }
  if (poHasAcknowledgedLines
    && /\b(issue|problem|delay(?:ed)?|late|reschedule|push(?:ing)? (?:out|back)|walk(?:ing)? back|withdraw(?:ing)?)\b/.test(lower)
    && /\b(new (?:date|quantity|price)|deliver(?:y)? (?:date|by)|propos(?:e|ed)|instead)\b/.test(lower)) {
    return { ...base, kind: "line_exception", confidence: 0.82, reason: "The current message flags an exception on acknowledged lines with a counter-proposal." };
  }
  if (/\b(propos(?:e|ed)|request(?:ing)? (?:a )?change|need to change|instead|revise[ds]?)\b/.test(lower)
    && /\b(price|quantity|qty|delivery|promised|date)\b/.test(lower)) {
    return { ...base, kind: "pre_ack_modification", confidence: 0.78, reason: "The current message appears to propose a pre-acknowledgement commercial or delivery change." };
  }
  // #10 — a shipping notice: explicit ASN vocabulary outranks the ack reads
  // (a supplier "confirming shipment" is not acknowledging the PO).
  if (/\b(shipping notice|ship notice|\basn\b|has shipped|shipped (?:out|from|via)|bill of lading|tracking number|\bcarrier\b)\b/i.test(text)
    && hasProcurementSignal(text)) {
    return asnDecision(base, text, lower);
  }
  if (/\b(partial|only|remaining|except|excluding)\b/.test(lower)
    && /\b(acknowledge|confirm|accept)\b/.test(lower)) {
    return { ...base, kind: "partial_acknowledgement", confidence: 0.80, reason: "The current message acknowledges only part of the purchase order." };
  }
  // #18 — the on-track confirmation, BEFORE the ack branches: "we confirm all
  // lines are on track" must never re-acknowledge an acknowledged PO. No
  // change proposal may accompany it (a flagged problem routes above).
  if (/\b(on track|on schedule|no issues|all good|everything (?:is )?(?:fine|ok|good|on track)|will (?:deliver|ship)(?: as (?:planned|scheduled|promised)| on time)?)\b/.test(lower)
    && !/\b(price|quantity|qty|need[- ]by|delivery (?:date|time)|promised|reschedule|delay(?:ed)?|late|can'?t|cannot|unable|propos(?:e|ed)|change)\b/.test(lower)) {
    return { ...base, kind: "po_on_track", confidence: 0.80, reason: "The current message confirms the outstanding lines are on track with no change proposed." };
  }
  if (/\b(acknowledge[ds]?|confirmed?|accept(?:ed)?)\b/.test(lower)
    && /\b(all|in full|as written|purchase order|\bpo\b)\b/.test(lower)) {
    return { ...base, kind: "full_acknowledgement", confidence: 0.84, reason: "The current message acknowledges the purchase order as written." };
  }
  if (poCode && /\b(purchase order|\bpo\b)\b/.test(lower)
    && (message?.direction === "outbound" || /\b(please find attached|new purchase order|attached po)\b/.test(lower))) {
    return { ...base, kind: "po_creation", confidence: 0.76, reason: "The current message appears to introduce a new purchase order." };
  }
  if (!hasProcurementSignal(text)) {
    return { ...base, kind: "no_ticket", confidence: 0.96, reason: "The current message is clearly unrelated to procurement or purchase orders and requires no buyer action." };
  }
  return { ...base, kind: "triage", confidence: 0.45, reason: "The local fallback could not safely classify the current message into scenarios 1-5." };
}

/**
 * True when the current outbound buyer message introduces a NEW PO absent from
 * the case file — the signal that routes po_creation through the dedicated
 * extraction pass rather than the general classifier (see decideTicketEnvelope
 * in SOR).
 */
export function isNewOutboundPoRoot(
  context: ScoutCaseContext,
  current?: ScoutMessage,
): boolean {
  if (!current || current.direction !== "outbound" || /^\s*(?:re|fw|fwd):/i.test(current.subject ?? "")) return false;
  const text = `${current.subject ?? ""}\n${current.bodyText ?? ""}`;
  const poCode = findPoCode(text);
  return Boolean(poCode && /\b(purchase order|\bpo\b)\b/i.test(text)
    && !context.purchaseOrders.some((po) => po.poCode === poCode));
}

// ---------------------------------------------------------------------------
// #10 / #16 local extraction (no model, no API keys)
// ---------------------------------------------------------------------------

const NDR_PATTERNS = [
  /\bdelivery status notification\b/i,
  /\bmail delivery (?:failed|failure)\b/i,
  /\bundeliverable\b/i,
  /\bdelivery (?:has|to the following recipients) failed\b/i,
  /\breturned to sender\b/i,
  /\baddress not found\b/i,
  /\b(?:no such user|recipient unknown|unknown recipient)\b/i,
  /\bmessage could not be delivered\b/i,
  /\bmailer[- ]daemon\b/i,
  /\b(?:550|5\.1\.1|5\.2\.2|5\.7\.1)\b/,
] as const;

const LEFT_COMPANY_PATTERNS = [
  /\bleft (?:the )?company\b/i,
  /\bno longer (?:with|employed by|at) (?:the )?[a-z][a-z0-9 .'-]{0,30}\b/i,
  /\bhas left (?:our )?(?:the )?company\b/i,
  /\bis no longer employed\b/i,
] as const;

/** The most recent outbound message of the thread — the failed send. */
function lastOutboundMessage(context: ScoutCaseContext): ScoutMessage | null {
  return [...context.messages].reverse().find((message) => message.direction === "outbound") ?? null;
}

function detectDeliveryFailure(
  context: ScoutCaseContext,
  text: string,
  lower: string,
): EnvelopeDecision | null {
  const ndr = NDR_PATTERNS.some((pattern) => pattern.test(lower));
  const leftCompany = LEFT_COMPANY_PATTERNS.some((pattern) => pattern.test(lower));
  if (!ndr && !leftCompany) return null;
  const outbound = lastOutboundMessage(context);
  if (!outbound) return null;
  // The NDR usually quotes the failed recipient; fall back to the outbound
  // message's first addressee.
  const quoted = text.match(/\b(?:to|recipient|failed recipient)[:\s]*[<]?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i)?.[1];
  const failedContact = (quoted ?? outbound.to[0]?.email)?.toLowerCase() ?? null;
  if (!failedContact) return null;
  const reason = leftCompany
    ? "left_company"
    : /\bmailbox full\b|\bquota\b/i.test(lower)
      ? "mailbox_full"
      : "hard_bounce";
  return {
    kind: "delivery_failure",
    confidence: 0.84,
    reason: "The current message is a delivery failure (NDR or left-company auto-reply) for a prior outbound message.",
    poId: null,
    poCode: findPoCode(text) ?? findPoCode(outbound.subject ?? "") ?? context.purchaseOrders[0]?.poCode ?? null,
    supplierCode: null,
    supplierName: null,
    affectedPoCodes: [],
    affectedPartCodes: [],
    rejectionReason: null,
    modifications: [],
    purchaseOrder: null,
    payload: {
      failedContact,
      bouncedMessage: outbound.subject ?? outbound.providerMessageId ?? "the bounced message",
      bounceReason: reason,
    },
  };
}

function asnDecision(base: LocalDecision, text: string, lower: string): EnvelopeDecision {
  const shipDate = extractIsoDate(text, /(?:shipped|ship\s*date|date\s*shipped)[^\d]*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)
    ?? extractIsoDate(text, /\b(\d{4}-\d{2}-\d{2})\b/);
  const trackingNumber = text.match(/\btracking\s*(?:number|#|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i)?.[1] ?? null;
  const carrier = text.match(/\b(?:carrier|shipped\s+(?:by|via))\s*[:#]?\s*([A-Za-z][A-Za-z0-9 .-]{1,30})/i)?.[1]?.trim() ?? null;
  const expectedDelivery = extractIsoDate(text, /(?:expected\s*(?:delivery)?\s*(?:date)?|\beta\b|est\.?\s*delivery|delivery\s*(?:date|est\.?))\s*[:#]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i) ?? null;
  const lines = parseShippedLines(text);
  // #10b (batch-4 04): a tracking/carrier follow-up carries NO shipped
  // quantities — it patches an already-recorded shipment. Emit the update
  // variant so the builder binds the asns row instead of degrading to triage.
  const update = lines.length === 0 && (trackingNumber || carrier)
    ? { trackingNumber, carrier, expectedDelivery, ofDateShipped: shipDate }
    : null;
  return {
    ...base,
    kind: "asn",
    confidence: 0.78,
    reason: update
      ? "The current message adds tracking or carrier details to an already-recorded shipment."
      : "The current message appears to be a supplier shipping notice.",
    affectedPartCodes: [...new Set([...base.affectedPartCodes, ...lines.map((line) => line.partCode)])],
    payload: { shipDate, carrier, trackingNumber, expectedDelivery, lines, ...(update ? { update } : {}) },
  };
}

/** ISO-normalize a date in YYYY-MM-DD, M/D/YYYY, or D-M-YYYY form. */
function extractIsoDate(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern)?.[1];
  if (!match) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(match)
    ? match
    : (() => {
      const parts = match.split(/[\/-]/);
      const [a, b, year] = parts;
      if (!a || !b || !year) return null;
      const numA = Number(a);
      const numB = Number(b);
      if (!Number.isFinite(numA) || !Number.isFinite(numB) || !Number.isFinite(Number(year))) return null;
      // US order when the first token is a month number > 12, else assume
      // day-first (the supplier's local convention is unknowable — prefer
      // month-first, the N. American norm for purchase orders).
      const month = numA > 12 ? numB : numA;
      const day = numA > 12 ? numA : numB;
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    })();
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/** "PART shipped qty of qty" / "PART qty of qty" / "shipped X units of PART" pairs. */
function parseShippedLines(text: string): Array<{ partCode: string; quantityShipped: number }> {
  const pairs: Array<{ partCode: string; quantityShipped: number }> = [];
  for (const match of text.matchAll(/\b([A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+)\s+(?:(?:shipped|qty|quantity)\s*[:=]?\s*)?(\d[\d,]*(?:\.\d+)?)\s*(?:of|out of|\/)\s*(\d[\d,]*(?:\.\d+)?)\b/gi)) {
    const partCode = match[1]!;
    if (partCode.toUpperCase().startsWith("PO-")) continue;
    const shipped = Number(match[2]!.replace(/,/g, ""));
    if (Number.isFinite(shipped) && shipped > 0) pairs.push({ partCode, quantityShipped: shipped });
  }
  // "shipped X units of PART" form, when the pair form found nothing.
  if (pairs.length === 0) {
    for (const match of text.matchAll(/\bshipped\s+(\d[\d,]*(?:\.\d+)?)\s+(?:units?|pieces?|ea\.?|qty)\s+of\s+([A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+)\b/gi)) {
      const shipped = Number(match[1]!.replace(/,/g, ""));
      const partCode = match[2]!;
      if (Number.isFinite(shipped) && shipped > 0 && !partCode.toUpperCase().startsWith("PO-")) {
        pairs.push({ partCode, quantityShipped: shipped });
      }
    }
  }
  return pairs;
}

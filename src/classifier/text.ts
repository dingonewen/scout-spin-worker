// ---------------------------------------------------------------------------
// Shared identifier + signal helpers used by the deterministic fallback
// (local.ts) and the identifier normalizer (normalize.ts). Ported verbatim from
// packages/email-worker/src/tickets/ticket-agent.ts — pure string/regex work
// only, so it runs in the Spin JS runtime and under plain Node alike.
// ---------------------------------------------------------------------------

/** The first PO code in a block of text, canonicalized to `PO-XXXX…`. */
export function findPoCode(text: string): string | null {
  const match = text.match(/\bPO[-\s#:]?[A-Z0-9][A-Z0-9-]{2,}\b/i)?.[0];
  return match ? match.replace(/[\s#:]+/g, "-").toUpperCase() : null;
}

/** Dense part-code tokens (`PN-100`, `6205-2RS`), excluding anything PO-shaped. */
export function findPartCodes(text: string): string[] {
  const matches = text.match(/\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/g) ?? [];
  return [...new Set(matches.filter((value) => !value.toUpperCase().startsWith("PO-")))];
}

/**
 * Does this text look like procurement traffic at all? The final no_ticket
 * gate in the local fallback — a message with neither procurement vocabulary
 * nor a PO code cannot produce a ticket.
 */
export function hasProcurementSignal(text: string): boolean {
  return /\b(?:purchase\s+order|procurement|requisition|supplier|vendor|acknowledg(?:e|ed|ement)|commercial\s+terms?|unit\s+price|need[- ]by|promised\s+date|all\s+lines|part(?:ial)?\s+acknowledgement)\b/i.test(text)
    || /\bPO[-\s#:]?[A-Z0-9][A-Z0-9-]{2,}\b/i.test(text);
}

/** Trim + empty→null. */
export function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

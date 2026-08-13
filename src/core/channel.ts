import type { TicketEventEnvelope } from "../contract/envelope";
import type { ScoutCaseContext } from "../contract/scout-context";

/**
 * Channel derivation — ported from process-thread.ts. Cloudflare-inbox mail
 * arrives as `scout_cc`; Nylas-inbox mail keeps the buyer_cc / supplier_direct
 * split by message direction.
 */
export function channelForMessage(
  context: ScoutCaseContext,
  message: { id: string; direction: string },
): TicketEventEnvelope["channel"] {
  const loaded = context.messages.find((entry) => entry.id === message.id);
  if (loaded?.inboxProvider === "cloudflare") return "scout_cc";
  return message.direction === "outbound" ? "buyer_cc" : "supplier_direct";
}

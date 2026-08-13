import type { EnvelopeDecision } from "../src/contract/envelope";
import type { ScoutCaseContext, ScoutMessage, ScoutPurchaseOrder, ScoutSupplierContact } from "../src/contract/scout-context";
import type { InboundEmail } from "../src/core/pipeline";

// ---------------------------------------------------------------------------
// Seed fixtures: one org, one thread, one open PO, and six inbound emails that
// exercise the five in-scope scenarios plus a noise case. These stand in for
// the SOR rows the real `tickets.scoutCaseContext` query would return.
// ---------------------------------------------------------------------------

export const demoOrgId = "org_demo";
export const demoThreadId = "thread_demo";

export const demoSupplierContact: ScoutSupplierContact = {
  contactId: "c-1",
  supplierCode: "SUP-ACME",
  name: "Dana (Accounts)",
  email: "accounts@acme.example",
  phone: null,
  isPrimary: true,
  version: 1,
};

export const demoPurchaseOrder: ScoutPurchaseOrder = {
  poId: "po-2026-1001",
  poCode: "PO-2026-1001",
  supplierCode: "SUP-ACME",
  supplierName: "Acme Parts Co",
  status: "pending_ack",
  orderDate: "2026-08-01",
  ownerUserId: "user-1",
  version: 3,
  updatedAt: "2026-08-01T00:00:00.000Z",
  asns: [],
  lines: [
    { lineId: "ln-1", poId: "po-2026-1001", reqLineId: null, partCode: "PN-100", quantity: 100, unitPrice: 4.5, status: "pending_ack", promisedDate: "2026-08-20", exceptionReason: null, asnRequestedAt: null, leadtimeConfirmedAt: null, leadtimeOnTrackAt: null, version: 2 },
    { lineId: "ln-2", poId: "po-2026-1001", reqLineId: null, partCode: "PN-200", quantity: 50, unitPrice: 12.0, status: "pending_ack", promisedDate: "2026-08-22", exceptionReason: null, asnRequestedAt: null, leadtimeConfirmedAt: null, leadtimeOnTrackAt: null, version: 2 },
    { lineId: "ln-3", poId: "po-2026-1001", reqLineId: null, partCode: "PN-300", quantity: 200, unitPrice: 2.0, status: "pending_ack", promisedDate: "2026-08-25", exceptionReason: null, asnRequestedAt: null, leadtimeConfirmedAt: null, leadtimeOnTrackAt: null, version: 2 },
  ],
};

function decision(kind: string, overrides: Partial<EnvelopeDecision> = {}): EnvelopeDecision {
  return {
    kind,
    poId: null,
    poCode: null,
    supplierCode: null,
    affectedPoCodes: [],
    confidence: 0.95,
    reason: "stub decision for the demo",
    supplierName: null,
    affectedPartCodes: [],
    rejectionReason: null,
    modifications: [],
    purchaseOrder: null,
    payload: {},
    ...overrides,
  };
}

export type SeedCase = {
  scenario: number; // 0 = noise, else the ticket-scenarios number
  label: string;
  email: InboundEmail;
  expected: EnvelopeDecision;
};

export const seedCases: SeedCase[] = [
  {
    scenario: 1,
    label: "po_creation",
    email: {
      messageId: "seed-1-po-creation",
      threadId: "thread_new_po",
      orgId: demoOrgId,
      subject: "New order PO-2027-2001",
      body: "Please set up the following new purchase order: PO-2027-2001 for Acme Parts Co. 500x PN-900 bolts at $0.90 each, need-by 2026-09-01.",
      from: "buyer@buyer.example",
      receivedAt: "2026-08-13T09:00:00.000Z",
    },
    expected: decision("po_creation", {
      purchaseOrder: {
        poCode: "PO-2027-2001",
        supplierCode: "SUP-ACME",
        supplierName: "Acme Parts Co",
        orderDate: "2026-08-13",
        lines: [{ partCode: "PN-900", partName: "Bolt", partSpec: "M8", quantity: 500, unitPrice: 0.9, needBy: "2026-09-01" }],
      },
      reason: "Buyer issued a new purchase order.",
    }),
  },
  {
    scenario: 2,
    label: "full_acknowledgement",
    email: {
      messageId: "seed-2-full-ack",
      threadId: demoThreadId,
      orgId: demoOrgId,
      subject: "Re: PO-2026-1001",
      body: "We acknowledge PO-2026-1001 in full and confirm all lines and dates.",
      from: "accounts@acme.example",
      receivedAt: "2026-08-13T09:05:00.000Z",
    },
    expected: decision("full_acknowledgement", {
      poCode: "PO-2026-1001",
      reason: "Supplier acknowledged the entire PO.",
    }),
  },
  {
    scenario: 3,
    label: "partial_acknowledgement",
    email: {
      messageId: "seed-3-partial-ack",
      threadId: demoThreadId,
      orgId: demoOrgId,
      subject: "Re: PO-2026-1001",
      body: "We can acknowledge PN-100 and PN-200 on PO-2026-1001, but PN-300 is under review.",
      from: "accounts@acme.example",
      receivedAt: "2026-08-13T09:10:00.000Z",
    },
    expected: decision("partial_acknowledgement", {
      poCode: "PO-2026-1001",
      affectedPartCodes: ["PN-100", "PN-200"],
      reason: "Supplier acknowledged a subset of lines.",
    }),
  },
  {
    scenario: 9,
    label: "line_exception",
    email: {
      messageId: "seed-4-exception",
      threadId: demoThreadId,
      orgId: demoOrgId,
      subject: "Exception on PO-2026-1001",
      body: "Steel costs rose — we cannot hold PN-300 at $2.00. We propose $2.50/unit instead.",
      from: "accounts@acme.example",
      receivedAt: "2026-08-13T09:15:00.000Z",
    },
    expected: decision("line_exception", {
      poCode: "PO-2026-1001",
      affectedPartCodes: ["PN-300"],
      modifications: [{ partCode: "PN-300", field: "unit_price", proposedValue: 2.5, reason: "steel costs rose" }],
      reason: "Supplier raised an exception with a counter-offer.",
    }),
  },
  {
    scenario: 10,
    label: "asn",
    email: {
      messageId: "seed-5-asn",
      threadId: demoThreadId,
      orgId: demoOrgId,
      subject: "Shipment for PO-2026-1001",
      body: "Shipped 100x PN-100 on PO-2026-1001 via UPS, tracking 1Z999, expected delivery 2026-08-20.",
      from: "accounts@acme.example",
      receivedAt: "2026-08-13T09:20:00.000Z",
    },
    expected: decision("asn", {
      poCode: "PO-2026-1001",
      payload: {
        shipDate: "2026-08-18",
        carrier: "UPS",
        trackingNumber: "1Z999",
        expectedDelivery: "2026-08-20",
        lines: [{ partCode: "PN-100", quantityShipped: 100 }],
      },
      reason: "Supplier sent an advance shipping notice.",
    }),
  },
  {
    scenario: 0,
    label: "noise",
    email: {
      messageId: "seed-0-noise",
      threadId: demoThreadId,
      orgId: demoOrgId,
      subject: "Thanks",
      body: "Thanks, I'll circle back next week.",
      from: "someone@example.com",
      receivedAt: "2026-08-13T09:25:00.000Z",
    },
    expected: decision("no_ticket", {
      reason: "Not actionable procurement traffic.",
    }),
  },
];

/** Build the case context the mock serves for a (org, thread, message) query. */
export function buildContext(req: { orgId: string; threadId: string; currentMessageId: string }): ScoutCaseContext {
  const seed = seedCases.find((c) => c.email.messageId === req.currentMessageId);
  const message: ScoutMessage = {
    id: req.currentMessageId,
    providerMessageId: req.currentMessageId,
    messageIdHeader: null,
    subject: seed?.email.subject ?? req.currentMessageId,
    bodyText: seed?.email.body ?? "",
    from: [{ email: seed?.email.from ?? "unknown@example.com" }],
    to: [{ email: seed?.email.to ?? "scout@demo.example" }],
    cc: [],
    receivedAt: seed?.email.receivedAt ?? null,
    direction: "inbound",
    attachments: [],
    inboxUserId: "user-1",
    inboxProvider: "cloudflare",
  };

  return {
    orgId: req.orgId,
    currentMessageId: message.id,
    memberUserIds: ["user-1"],
    thread: {
      id: req.threadId,
      providerThreadId: req.threadId,
      subject: message.subject,
      participants: [],
      messageCount: 1,
    },
    messages: [message],
    attachmentExtractions: [],
    purchaseOrders: [demoPurchaseOrder],
    supplierContacts: [demoSupplierContact],
    priorTickets: [],
    priorIngestion: [],
  };
}

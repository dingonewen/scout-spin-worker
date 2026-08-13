// ---------------------------------------------------------------------------
// The case-context contract — the shape returned by the ticket API's
// `tickets.scoutCaseContext` query (mirrors
// packages/email-worker/src/tickets/case-context.ts). The Spin worker reads
// this, feeds it to the classifier, and never writes to it directly.
//
// It is a faithful SUBSET: only the fields the five in-scope scenarios
// (#1 #2 #3 #9 #10) and the classifier touch. Timestamps arrive as ISO
// strings over the wire (the tRPC link has no superjson transformer — same
// gotcha as the SOR worker).
// ---------------------------------------------------------------------------

export type ScoutLine = {
  lineId: string;
  poId: string;
  reqLineId: string | null;
  partCode: string | null;
  quantity: number | string;
  unitPrice: number | string | null;
  status: string;
  promisedDate: string | null;
  exceptionReason: string | null;
  asnRequestedAt: string | null;
  leadtimeConfirmedAt: string | null;
  leadtimeOnTrackAt: string | null;
  version: number;
};

export type ScoutAsn = {
  asnId: string;
  poId: string;
  lineId: string;
  quantityShipped: number | string;
  dateShipped: string | null;
  expectedDeliveryDate: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  version: number;
};

export type ScoutPurchaseOrder = {
  poId: string;
  poCode: string;
  supplierCode: string | null;
  supplierName: string | null;
  status: string;
  orderDate: string | null;
  ownerUserId: string | null;
  version: number;
  updatedAt: string | null;
  lines: ScoutLine[];
  /** Recorded shipments (#10b); absent = none recorded. */
  asns?: ScoutAsn[];
};

export type ScoutMessage = {
  id: string;
  providerMessageId: string;
  messageIdHeader: string | null;
  subject: string;
  bodyText: string | null;
  from: Array<{ name?: string | null; email: string }>;
  to: Array<{ name?: string | null; email: string }>;
  cc: Array<{ name?: string | null; email: string }>;
  receivedAt: string | null;
  direction: string;
  attachments: unknown;
  inboxUserId: string | null;
  inboxProvider: string | null;
};

export type ScoutSupplierContact = {
  contactId: string;
  supplierCode: string | null;
  name: string | null;
  email: string;
  phone: string | null;
  isPrimary: boolean | null;
  version: number;
};

export type ScoutPriorTicket = {
  ticketId: string;
  kindKey: string;
  title: string;
  status: string;
  creationReason: string | null;
  steps: unknown;
  resolution: unknown;
  closedKind: string | null;
  closedReason: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
};

export type ScoutPriorIngestion = {
  channel: string;
  semanticHash: string;
  outcome: string;
  ticketId: string | null;
  createdAt: string | null;
};

export type ScoutCaseContext = {
  orgId: string;
  currentMessageId: string;
  memberUserIds: string[];
  thread: {
    id: string;
    providerThreadId: string | null;
    subject: string;
    participants: unknown;
    messageCount: number;
  };
  messages: ScoutMessage[];
  attachmentExtractions: Array<{
    id: string;
    messageId: string;
    filename: string | null;
    status: string | null;
    extractedMarkdown: string | null;
  }>;
  purchaseOrders: ScoutPurchaseOrder[];
  supplierContacts: ScoutSupplierContact[];
  priorTickets: ScoutPriorTicket[];
  priorIngestion: ScoutPriorIngestion[];
};

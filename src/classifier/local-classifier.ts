import type { EnvelopeDecision } from "../contract/envelope";
import { decideTicketLocally, isNewOutboundPoRoot } from "./local";
import { findPoCode } from "./text";
import type { Classifier, ClassifyInput } from "./interface";

/**
 * The deterministic (LLM-less) classifier — SOR's no-API-key fallback made
 * explicit behind the Classifier interface, so the A/B harness can score it
 * against the direct-LLM path on the same corpus.
 *
 * SOR never uses `decideTicketLocally` standalone for a new-PO root: its
 * `decideTicketEnvelope` intercepts outbound new-PO roots via
 * `isNewOutboundPoRoot` (routing them to the extraction agent) *before* the
 * regex fallback runs. This class reproduces that orchestration for the local
 * path — an outbound root introducing a PO absent from the case file is
 * po_creation, decided up front. Without this step the fallback's
 * full_acknowledgement branch (which is not direction-gated and sits above
 * po_creation) would shadow a buyer's "please confirm this PO" into a supplier
 * acknowledgement — the exact divergence the direct-LLM path avoids via the
 * same `isNewOutboundPoRoot` check in llm.ts.
 *
 * Emits a single decision (it never splits); normalization happens in the
 * pipeline, not here, so this stays a thin deterministic adapter.
 */
export class LocalClassifier implements Classifier {
  readonly id = "local-regex";

  async classify(input: ClassifyInput): Promise<EnvelopeDecision[]> {
    const { context, currentMessage } = input;

    if (isNewOutboundPoRoot(context, currentMessage)) {
      const text = `${currentMessage.subject ?? ""}\n${currentMessage.bodyText ?? ""}`;
      return [{
        kind: "po_creation",
        confidence: 0.76,
        poId: null,
        poCode: findPoCode(text),
        supplierCode: null,
        supplierName: null,
        affectedPoCodes: [],
        affectedPartCodes: [],
        rejectionReason: null,
        modifications: [],
        purchaseOrder: null,
        payload: {},
        reason: "The current outbound root message introduces a new PO that is absent from the SOR.",
      }];
    }

    return [decideTicketLocally(context, currentMessage)];
  }
}

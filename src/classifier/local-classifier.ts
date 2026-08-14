import type { EnvelopeDecision } from "../contract/envelope";
import { decideTicketLocally } from "./local";
import type { Classifier, ClassifyInput } from "./interface";

/**
 * The deterministic (LLM-less) classifier — `decideTicketLocally` wrapped as a
 * Classifier so the A/B harness can score the SOR regex baseline against the
 * direct-LLM path on the same corpus. This is SOR's no-API-key fallback made
 * explicit: `decideTicketEnvelope` returns `decideTicketLocally`'s verdict
 * when neither OpenAI nor DeepSeek is configured, and this is that same
 * classifier behind the swappable interface.
 *
 * Emits a single decision (it never splits); normalization happens in the
 * pipeline, not here, so this stays a thin deterministic adapter.
 */
export class LocalClassifier implements Classifier {
  readonly id = "local-regex";

  async classify(input: ClassifyInput): Promise<EnvelopeDecision[]> {
    return [decideTicketLocally(input.context, input.currentMessage)];
  }
}

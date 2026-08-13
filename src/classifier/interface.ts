import type { EnvelopeDecision, TicketEventEnvelope } from "../contract/envelope";
import type { ScoutCaseContext } from "../contract/scout-context";

export type ClassifyInput = {
  context: ScoutCaseContext;
  /** The message being classified (must be a member of context.messages). */
  currentMessage: ScoutCaseContext["messages"][number];
  channel: TicketEventEnvelope["channel"];
};

/**
 * The swappable classification core. The direct-LLM implementation ships
 * first; a Mastra-on-Spin spike (or the deterministic fallback) can be dropped
 * in behind this same interface for the A/B run without touching the pipeline.
 */
export interface Classifier {
  readonly id: string;
  classify(input: ClassifyInput): Promise<EnvelopeDecision[]>;
}

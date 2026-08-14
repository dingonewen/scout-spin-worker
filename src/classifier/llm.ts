import { EnvelopeDecisionsSchema, PurchaseOrderSchema, type EnvelopeDecision } from "../contract/envelope";
import { isNewOutboundPoRoot } from "./local";
import {
  buildPoExtractionSystemPrompt,
  buildPoExtractionUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt";
import type { Classifier, ClassifyInput } from "./interface";

/**
 * Direct-LLM classifier: an OpenAI-compatible chat-completions call (DeepSeek,
 * OpenAI, or any compatible endpoint) with JSON mode, validated against
 * EnvelopeDecisionsSchema. Temperature 0 for deterministic classification
 * (matches ticket-agent.ts's modelSettings).
 *
 * A buyer's outbound root message that introduces a NEW PO routes through a
 * second call — the dedicated new-PO fact extractor (SOR's newPoExtractionAgent)
 * — so po_creation carries validated header + line facts rather than the
 * general classifier's best guess.
 */
export class LlmClassifier implements Classifier {
  readonly id = "direct-llm";

  constructor(
    private readonly opts: { baseUrl: string; model: string; apiKey: string },
  ) {}

  async classify(input: ClassifyInput): Promise<EnvelopeDecision[]> {
    if (!this.opts.apiKey) {
      throw new Error("LLM_API_KEY is not set — the live classifier needs a key (or run the deterministic prefilter).");
    }

    const parsed = EnvelopeDecisionsSchema.parse(await this.complete([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(input) },
    ]));
    let decisions = parsed.decisions;

    if (isNewOutboundPoRoot(input.context, input.currentMessage)
      && !decisions.some((decision) => decision.kind === "po_creation")) {
      const purchaseOrder = PurchaseOrderSchema.parse(await this.complete([
        { role: "system", content: buildPoExtractionSystemPrompt() },
        { role: "user", content: buildPoExtractionUserPrompt(input) },
      ]));
      decisions = [{
        kind: "po_creation",
        poId: null,
        poCode: purchaseOrder.poCode,
        supplierCode: purchaseOrder.supplierCode,
        supplierName: purchaseOrder.supplierName,
        affectedPoCodes: [],
        confidence: Math.max(decisions[0]?.confidence ?? 0, 0.9),
        reason: "The current outbound root message introduces a new PO that is absent from the SOR; supplier replies elsewhere in the thread are context, not the current event.",
        affectedPartCodes: purchaseOrder.lines.map((line) => line.partCode),
        rejectionReason: null,
        modifications: [],
        purchaseOrder,
        payload: {},
      }];
    }

    return decisions;
  }

  /** One chat-completions round trip → the parsed JSON body (throws on non-JSON). */
  private async complete(
    messages: Array<{ role: "system" | "user"; content: string }>,
  ): Promise<unknown> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("LLM returned no message content.");

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`LLM returned non-JSON content: ${raw.slice(0, 200)}`);
    }
  }
}

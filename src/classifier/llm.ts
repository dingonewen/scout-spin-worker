import { EnvelopeDecisionsSchema, type EnvelopeDecision } from "../contract/envelope";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { Classifier, ClassifyInput } from "./interface";

/**
 * Direct-LLM classifier: an OpenAI-compatible chat-completions call (DeepSeek,
 * OpenAI, or any compatible endpoint) with JSON mode, validated against
 * EnvelopeDecisionsSchema. Temperature 0 for deterministic classification
 * (matches ticket-agent.ts's modelSettings).
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
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(input) },
        ],
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

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error(`LLM returned non-JSON content: ${raw.slice(0, 200)}`);
    }

    const parsed = EnvelopeDecisionsSchema.parse(parsedJson);
    return parsed.decisions;
  }
}

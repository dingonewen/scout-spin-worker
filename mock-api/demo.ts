import type { AddressInfo } from "node:net";
import { TicketApiClient } from "../src/api-client";
import type { Classifier, ClassifyInput } from "../src/classifier/interface";
import type { EnvelopeDecision } from "../src/contract/envelope";
import { runTicketPipeline } from "../src/core/pipeline";
import { assertScenario } from "../src/scenarios";
import { seedCases } from "./fixtures";
import { startMockServer } from "./server";

// ---------------------------------------------------------------------------
// End-to-end smoke test of the prototype's contract WITHOUT a live LLM or a
// Spin runtime: a stub classifier returns each scenario's hand-written
// decision, and the pipeline proves email → scoutCaseContext → classify →
// ingestEnvelope → { txid, outcomes }. Run: `npm run demo`.
// ---------------------------------------------------------------------------

class StubClassifier implements Classifier {
  readonly id = "stub";
  constructor(private readonly byMessageId: Map<string, EnvelopeDecision[]>) {}
  async classify(input: ClassifyInput): Promise<EnvelopeDecision[]> {
    const decision = this.byMessageId.get(input.currentMessage.providerMessageId);
    if (!decision) throw new Error(`No stub decision for ${input.currentMessage.providerMessageId}`);
    return decision;
  }
}

const server = await startMockServer(0);
const address = server.address() as AddressInfo | null;
const api = new TicketApiClient({ baseUrl: `http://localhost:${address?.port ?? 8787}`, apiKey: "dev-key" });

let passed = 0;
for (const seed of seedCases) {
  const classifier = new StubClassifier(new Map([[seed.email.messageId, [seed.expected]]]));
  const result = await runTicketPipeline(seed.email, { classifier, api });
  const decision = result.envelope.decisions[0];
  const outcome = result.response.outcomes[0];

  if (seed.scenario === 0) {
    if (decision?.kind !== "no_ticket" || outcome?.outcome !== "no_ticket") {
      throw new Error(`noise case expected no_ticket, got ${decision?.kind}/${outcome?.outcome}`);
    }
    console.log(`noise              → no_ticket → ${outcome?.outcome} (ticket none)`);
  } else {
    assertScenario(seed.scenario, decision!);
    console.log(`scenario #${seed.scenario} (${seed.label.padEnd(22)}) → ${decision!.kind} → ${outcome?.outcome} (ticket ${outcome?.ticketId ?? "none"})`);
  }
  passed += 1;
}

server.close();
console.log(`\n${passed}/${seedCases.length} cases passed. email → ticket API is wired end-to-end.`);

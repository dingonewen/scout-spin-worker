import type { EnvelopeDecision } from "./contract/envelope";

// ---------------------------------------------------------------------------
// The five in-scope scenarios and the classifier contract for each. This is
// both the reference map and the test assertion source (see mock-api/demo.ts).
// Anything the classifier emits outside these kinds is out of scope and, in
// the real API, would build under a not-yet-landed builder or downgrade to
// triage (see ticket-builder.ts's tail).
// ---------------------------------------------------------------------------

export type ScenarioKey = 1 | 2 | 3 | 9 | 10;

export const SCENARIO_KIND: Record<ScenarioKey, string> = {
  1: "po_creation",
  2: "full_acknowledgement",
  3: "partial_acknowledgement",
  9: "line_exception",
  10: "asn",
};

export type ScenarioAssertion = {
  scenario: ScenarioKey;
  kind: string;
  requiresPurchaseOrder?: boolean;
  requiresPoCode?: boolean;
  requiresAffectedParts?: boolean;
  requiresModifications?: boolean;
  requiresAsnPayload?: boolean;
  describe: string;
};

export const SCENARIO_ASSERTIONS: ScenarioAssertion[] = [
  {
    scenario: 1,
    kind: "po_creation",
    requiresPurchaseOrder: true,
    describe: "New PO from the buyer — purchaseOrder header + lines must be populated.",
  },
  {
    scenario: 2,
    kind: "full_acknowledgement",
    requiresPoCode: true,
    describe: "Supplier acknowledges the whole PO — affectedPartCodes stays empty.",
  },
  {
    scenario: 3,
    kind: "partial_acknowledgement",
    requiresPoCode: true,
    requiresAffectedParts: true,
    describe: "Supplier acknowledges some lines — affectedPartCodes names exactly the acked lines.",
  },
  {
    scenario: 9,
    kind: "line_exception",
    requiresPoCode: true,
    requiresModifications: true,
    describe: "Post-ack exception with a counter-offer — modifications[] carries the counter per line.",
  },
  {
    scenario: 10,
    kind: "asn",
    requiresPoCode: true,
    requiresAsnPayload: true,
    describe: "Advance shipping notice — payload.lines[] carries partCode + quantityShipped.",
  },
];

/** Assert a decision conforms to its scenario's contract. Throws on mismatch. */
export function assertScenario(scenario: ScenarioKey, decision: EnvelopeDecision): void {
  const expected = SCENARIO_ASSERTIONS.find((a) => a.scenario === scenario);
  if (!expected) throw new Error(`Unknown scenario ${scenario}`);
  if (decision.kind !== expected.kind) {
    throw new Error(`Scenario #${scenario}: expected kind ${expected.kind}, got ${decision.kind}`);
  }
  if (expected.requiresPoCode && !decision.poCode) {
    throw new Error(`Scenario #${scenario}: missing poCode`);
  }
  if (expected.requiresPurchaseOrder && !decision.purchaseOrder) {
    throw new Error(`Scenario #${scenario}: missing purchaseOrder`);
  }
  if (expected.requiresAffectedParts && decision.affectedPartCodes.length === 0) {
    throw new Error(`Scenario #${scenario}: missing affectedPartCodes`);
  }
  if (expected.requiresModifications && decision.modifications.length === 0) {
    throw new Error(`Scenario #${scenario}: missing modifications`);
  }
  if (expected.requiresAsnPayload) {
    const lines = decision.payload.lines;
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error(`Scenario #${scenario}: missing payload.lines`);
    }
  }
}

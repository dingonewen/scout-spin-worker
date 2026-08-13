import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { TicketEventEnvelopeSchema, resolveEnvelopeScopes } from "../src/contract/envelope";
import { ScoutCaseContextRequestSchema, type IngestEnvelopeResponse } from "../src/contract/ingest";
import { buildContext, demoOrgId, demoThreadId } from "./fixtures";

// ---------------------------------------------------------------------------
// Mock ticket API — a stand-in for the two procedures the real SOR API will
// expose: `tickets.scoutCaseContext` (read) and `tickets.ingestEnvelope`
// (the single write). It implements just enough of the boundary to prove the
// prototype's contract end-to-end: validate → resolve scopes → downgrade
// un-bindable decisions to triage → return a txid + per-decision outcomes.
// No Postgres, no ticket-builder — those live server-side in the real API.
// ---------------------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function ingest(envelope: unknown): IngestEnvelopeResponse {
  const parsed = TicketEventEnvelopeSchema.parse(envelope);
  // Resolve scopes against the single fixture org's context (the real API
  // re-loads the authoritative context server-side).
  const context = buildContext({ orgId: demoOrgId, threadId: demoThreadId, currentMessageId: parsed.providerEventId });
  const scoped = resolveEnvelopeScopes(context, parsed);

  const outcomes = scoped.decisions.map((decision, decisionIndex) => {
    if (decision.kind === "no_ticket") {
      return { decisionIndex, kind: decision.kind, outcome: "no_ticket", ticketId: null };
    }
    if (decision.kind === "triage") {
      return { decisionIndex, kind: decision.kind, outcome: "triage_created", ticketId: randomUUID() };
    }
    return { decisionIndex, kind: decision.kind, outcome: "ticket_created", ticketId: randomUUID() };
  });

  return {
    txid: `tx_${randomUUID()}`,
    outcomes,
    ticketIds: outcomes.map((o) => o.ticketId).filter((id): id is string => Boolean(id)),
  };
}

function createHandler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/scout-case-context") {
        const body = ScoutCaseContextRequestSchema.parse(await readJson(req));
        return send(res, 200, buildContext(body));
      }
      if (req.method === "POST" && url.pathname === "/ingest-envelope") {
        const body = await readJson(req);
        return send(res, 200, ingest(body));
      }
      return send(res, 404, { error: "not found" });
    } catch (error) {
      return send(res, 400, { error: String(error) });
    }
  };
}

export function startMockServer(port = 8787): Promise<Server> {
  const server = createServer(createHandler());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 8787);
  startMockServer(port).then(() => {
    console.log(`mock ticket API listening on http://localhost:${port}`);
  });
}

import type { ScoutCaseContext } from "./contract/scout-context";
import type {
  IngestEnvelopeRequest,
  IngestEnvelopeResponse,
  ScoutCaseContextRequest,
} from "./contract/ingest";

/**
 * The ticket API client — the worker's ONLY write path (and the only way it
 * reads case context). Sends the org x-api-key; the API resolves it to a mock
 * session for the org's service user and enforces tenancy server-side.
 *
 * Endpoint mapping: the mock exposes plain REST paths. The real SOR API would
 * be tRPC v11 over HTTP — POST /trpc/tickets.scoutCaseContext and
 * /trpc/tickets.ingestEnvelope with the same x-api-key header. Keep the
 * payload shapes identical; only the path differs.
 */
export class TicketApiClient {
  constructor(private readonly opts: { baseUrl: string; apiKey: string }) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Ticket API ${path} failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  scoutCaseContext(req: ScoutCaseContextRequest): Promise<ScoutCaseContext> {
    return this.post<ScoutCaseContext>("/scout-case-context", req);
  }

  ingestEnvelope(req: IngestEnvelopeRequest): Promise<IngestEnvelopeResponse> {
    return this.post<IngestEnvelopeResponse>("/ingest-envelope", req);
  }
}

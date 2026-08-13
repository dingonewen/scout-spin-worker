import { AutoRouter } from "itty-router";
import { TicketApiClient } from "./api-client";
import { LlmClassifier } from "./classifier/llm";
import { loadConfig } from "./config";
import { runTicketPipeline, type InboundEmail } from "./core/pipeline";

// ---------------------------------------------------------------------------
// Spin HTTP adapter — the only Spin-specific file. It is a thin shell over
// runTicketPipeline; all business logic lives in ./core and ./contract so it
// can be exercised with plain `tsx` without a Spin runtime.
// ---------------------------------------------------------------------------

const router = AutoRouter();

router.get("/health", () => json({ ok: true }));

router.post("/", async (request: Request) => {
  try {
    const email = (await request.json()) as InboundEmail;
    const config = loadConfig();
    const result = await runTicketPipeline(email, {
      classifier: new LlmClassifier(config.llm),
      api: new TicketApiClient(config.api),
    });
    return json(result);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Spin's fetch-event handler convention (see spin-globals.d.ts).
// @ts-ignore
addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(router.fetch(event.request));
});

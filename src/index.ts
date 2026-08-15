import { AutoRouter } from "itty-router";
import { get as getSpinVar } from "@spinframework/spin-variables";
import { TicketApiClient } from "./api-client";
import { LlmClassifier } from "./classifier/llm";
import { loadConfig, type AppConfig } from "./config";
import { runTicketPipeline, type InboundEmail } from "./core/pipeline";

// ---------------------------------------------------------------------------
// Spin HTTP adapter — the only Spin-specific file. It is a thin shell over
// runTicketPipeline; all business logic lives in ./core and ./contract so it
// can be exercised with plain `tsx` without a Spin runtime.
// ---------------------------------------------------------------------------

// Under Spin, `process.env` is NOT populated (ComponentizeJS ships no Node
// compat layer), so runtime config comes from spin.toml
// `[component.scout-spin-worker.variables]`, surfaced through the
// `fermyon:spin/variables` interface that `@spinframework/spin-variables`
// re-exports as a synchronous `get(key)`. We overlay those on top of
// `loadConfig()`'s defaults (which still read `process.env`, so the plain-Node
// mock/demo/eval path is unchanged).
function loadSpinConfig(): AppConfig {
  const defaults = loadConfig();
  const v = (key: string, fallback: string) => getSpinVar(key) ?? fallback;
  return {
    llm: {
      baseUrl: v("llm_base_url", defaults.llm.baseUrl),
      model: v("llm_model", defaults.llm.model),
      apiKey: v("llm_api_key", defaults.llm.apiKey),
    },
    api: {
      baseUrl: v("ticket_api_url", defaults.api.baseUrl),
      apiKey: v("ticket_api_key", defaults.api.apiKey),
    },
  };
}

const router = AutoRouter();

router.get("/health", () => json({ ok: true }));

router.post("/", async (request: Request) => {
  try {
    const email = (await request.json()) as InboundEmail;
    const config = loadSpinConfig();
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

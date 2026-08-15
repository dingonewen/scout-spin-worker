// ---------------------------------------------------------------------------
// Runtime config. This accessor reads `process.env` only — it is the source
// for the plain-Node path (the mock/demo/eval scripts run via `tsx`). Under
// Spin, `process.env` is NOT populated, so `src/index.ts` (the Spin entry)
// overlays the same five values from `[component.*.variables]` via
// `@spinframework/spin-variables` `get(key)`. Keeping the Spin-specific
// mechanism out of this module means the tsx scripts never resolve the
// `fermyon:spin/variables` WIT import.
//
// Everything has a safe local-dev default so the pipeline runs against the
// mock with zero configuration; only the live-LLM key is required.
// ---------------------------------------------------------------------------

export function env(name: string, fallback = ""): string {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
  return value ?? fallback;
}

export type AppConfig = {
  llm: {
    baseUrl: string;   // OpenAI-compatible chat completions base (e.g. https://api.deepseek.com)
    model: string;
    apiKey: string;
  };
  api: {
    baseUrl: string;   // ticket API base — mock (http://localhost:8787) or real Fastify API
    apiKey: string;    // org x-api-key
  };
};

export function loadConfig(): AppConfig {
  return {
    llm: {
      baseUrl: env("LLM_BASE_URL", "https://api.deepseek.com"),
      model: env("LLM_MODEL", "deepseek-chat"),
      apiKey: env("LLM_API_KEY"),
    },
    api: {
      baseUrl: env("TICKET_API_URL", "http://localhost:8787"),
      apiKey: env("TICKET_API_KEY", "dev-key"),
    },
  };
}

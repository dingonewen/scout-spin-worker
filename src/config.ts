// ---------------------------------------------------------------------------
// Runtime config. One accessor so the runtime-specific mechanism is a single
// change, not a sprawl:
//
//   - Plain Node (the mock + demo run via `tsx`): reads `process.env`.
//   - Spin (`spin up`): the component's variables come from `[variables]` /
//     `[component.*.variables]` in spin.toml and are surfaced through the SDK's
//     variables API (see the http-ts template's `src/spin.ts` for the symbol
//     your SDK version re-exports). `process.env` is NOT populated under Spin.
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

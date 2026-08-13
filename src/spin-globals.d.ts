// Minimal globals the Spin JS runtime provides to a fetch-triggered component.
// `fetch`, `Request`, and `Response` come from @types/node (undici); only the
// fetch-event listener pair is missing there. The Spin JS SDK ships equivalent
// declarations — regenerate with `spin new http-ts` if yours drift.
interface FetchEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

declare function addEventListener(
  type: "fetch",
  listener: (event: FetchEvent) => void,
): void;

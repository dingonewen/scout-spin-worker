# scout-spin-worker

A Spin (Fermyon WebAssembly) prototype for the ticket-handling half of the SOR
worker. It replaces the current BullMQ + resident-Node path — which writes
tickets **directly to Postgres**, bypassing the API trust boundary — with the
contract the boss asked for:

```
input  = email message
output = call to the ticket API
```

Only scenarios **#1 (PO creation), #2 (full ack), #3 (partial ack), #9
(line exception), #10 (ASN)** are handled. Anything else the classifier emits
is out of scope (and, in the real API, downgrades to triage).

## Why this shape

The current `packages/email-worker` loads case context, classifies, then calls
`ingestEventEnvelope` which runs a Postgres transaction **in-process**. That is
the trust-boundary violation this prototype fixes: the Spin component never
touches Postgres. It:

1. loads case context via `tickets.scoutCaseContext`,
2. classifies the email into a `TicketEventEnvelope` (a list of
   `EnvelopeDecision`),
3. POSTs the envelope to `tickets.ingestEnvelope` with the org `x-api-key`.

Scope resolution, ticket-proposal building, semantic-hash dedup, and the commit
all stay **server-side in the API** (inside its own transaction, returning a
txid). Notably, the semantic hash uses `node:crypto`, which Spin's JS runtime
does not provide — another reason dedup must live in the API.

## Layout

```
src/
├─ index.ts               # Spin HTTP adapter (thin shell; the only Spin file)
├─ config.ts              # env/variable accessor (Node env vs Spin variables)
├─ contract/
│  ├─ envelope.ts         # EnvelopeDecision + TicketEventEnvelope schemas (re-declared)
│  ├─ scout-context.ts    # ScoutCaseContext shape
│  └─ ingest.ts           # ingestEnvelope / scoutCaseContext request+response contract
├─ core/
│  ├─ pipeline.ts         # runTicketPipeline(email, deps) — the whole path
│  └─ channel.ts          # channelForMessage
├─ classifier/
│  ├─ interface.ts        # Classifier (swappable)
│  ├─ prompt.ts           # classification prompt (5 kinds)
│  ├─ llm.ts              # direct-LLM impl (OpenAI-compatible, temperature 0)
│  └─ prefilter.ts        # deterministic no_ticket fast path
├─ api-client.ts          # TicketApiClient (scoutCaseContext + ingestEnvelope)
└─ scenarios.ts           # the 5-scenario contract + assertions
mock-api/
├─ fixtures.ts            # seed org/thread/PO + 6 seed emails
├─ server.ts              # mock ticket API (node:http — no extra deps)
├─ demo.ts                # end-to-end smoke test (no LLM, no Spin)
└─ maildrop/
   ├─ adapter.ts          # .eml → InboundEmail parser + X-* ground truth
   └─ eval.ts             # batch classifier scorer over a directory of .eml
```

All business logic is Spin-free and runs under plain `tsx`. `src/index.ts` is
the only file that references Spin globals (`addEventListener("fetch")`).

## Run the mock + demo (no Spin, no LLM key)

```bash
npm install
npm run typecheck
npm run demo        # starts the mock in-process, exercises all 5 scenarios + noise
```

`demo.ts` proves the pipeline end-to-end with a stub classifier: email →
`scoutCaseContext` → classify → `ingestEnvelope` → `{ txid, outcomes }`, and
asserts each scenario's contract via `assertScenario`.

To exercise a real LLM against the mock, swap the stub in `demo.ts` for a
`LlmClassifier` (see `src/classifier/llm.ts`), or drive it through the Spin
HTTP adapter (`POST /`).

## Test with a maildrop (.eml) corpus

maildrop emits the raw RFC822/MIME wire format — many `.eml` files plus a JSON.
The JSON is the ML training labels; this harness ignores it and reads the
ground-truth `kind` from the first token of each email's `X-Labels` header.

```bash
npm run eval:dry -- path/to/maildrop            # parse-only: print kind/po/labels/body, no LLM
npm run eval:dry -- path/to/maildrop --limit 5  # first N files only
npm run eval -- path/to/maildrop                # classify + score (needs LLM_API_KEY)
```

`mock-api/maildrop/adapter.ts` hand-parses the MIME (RFC2047 subject, multipart
boundaries, quoted-printable/base64) with zero deps and turns each `.eml` into
the `InboundEmail` the pipeline consumes. It also normalizes two test artifacts:
maildrop's scenario #9 label `exception_with_counter` is mapped to SOR's ticket
kind `line_exception`, and the generator's `[Scout Test … #N]` subject prefix +
`Scout Test Case — …` body banner are stripped so the classifier isn't handed
the answer. `eval.ts` runs the `LlmClassifier` directly (not the full pipeline)
and scores the emitted `kind` against the normalized `X-Labels[0]`.

Two deliberate scope cuts:

- **No org/thread.** maildrop emails carry no org, so every email gets a fixed
  demo org and `threadId = messageId`; the org/thread resolver (layer 2) is out
  of scope for a classification eval.
- **Line-level correctness is not scored.** `X-Labels` gives a kind but not the
  expected part codes, so the eval builds a single synthetic PO (empty for
  `po_creation`, since a new PO is not on file yet) and leaves `lines` empty.
  Scoring `affectedPartCodes` / `modifications` would need the maildrop JSON.

## Run under Spin

The contract/core/classifier code is Spin-agnostic, but the **build plumbing**
(webpack → `j2w`/ComponentizeJS) is SDK-version-sensitive. Bootstrap it from the
official template rather than trusting hand-written config:

```bash
spin templates install --git https://github.com/spinframework/spin-js-sdk --update
spin new -t http-ts scout-spin-worker --accept-defaults
# copy this repo's src/ + spin.toml over the generated scaffold
spin build --up     # then POST an InboundEmail to http://localhost:3000/
```

Facts verified against the Spin JS SDK docs: npm package `@fermyon/spin-sdk`,
`allowed_outbound_hosts` gates outbound `fetch`, and `zod` is confirmed to work
in the Spin JS runtime.

## A/B: what to measure vs the current worker

| metric | current (BullMQ + resident Node) | Spin prototype |
|---|---|---|
| cold start | resident, no cold start | ~1ms scale-to-zero |
| idle cost | always-on worker (PM2) | $0 when idle |
| concurrency/isolation | shared process, one crash affects queue | one Wasm instance per request |
| ops footprint | Redis + PM2 + Bull Board + resident services | `spin up` / SpinKube / Fermyon Cloud |
| classification F1 | Mastra `scoutAgent` (baseline) | direct-LLM vs baseline on the same fixtures |

The swappable `Classifier` interface exists so a **Mastra-on-Spin spike** can be
dropped in for the same A/B run without touching the pipeline.

## Boundary notes (do not drift)

- `src/contract/envelope.ts` is a **duplicate** of
  `packages/email-worker/src/tickets/event-envelope.ts`. Keep them in sync.
- `tickets.ingestEnvelope` and `tickets.scoutCaseContext` do **not** exist in the
  SOR API yet — they are the two procedures this prototype's boundary implies.
  Wiring them is a follow-up on the SOR side (out of scope here).
- The worker never resolves `poId` authoritatively — it sends `poCode`; the API
  re-derives scope server-side (tenancy rule #1).

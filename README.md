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
├─ config.ts              # process.env accessor (Spin [variables] overlaid in index.ts)
├─ contract/
│  ├─ envelope.ts         # EnvelopeDecision + TicketEventEnvelope schemas (re-declared)
│  ├─ scout-context.ts    # ScoutCaseContext shape
│  └─ ingest.ts           # ingestEnvelope / scoutCaseContext request+response contract
├─ core/
│  ├─ pipeline.ts         # runTicketPipeline(email, deps) — the whole path
│  └─ channel.ts          # channelForMessage
├─ classifier/
│  ├─ interface.ts        # Classifier (swappable)
│  ├─ prompt.ts           # classification prompt (15 kinds) + PO-extraction prompt
│  ├─ llm.ts              # direct-LLM impl (OpenAI-compatible, temperature 0) + PO extraction
│  ├─ prefilter.ts        # deterministic no_ticket / whole_po_rejection fast path
│  ├─ local.ts            # decideTicketLocally — SOR's regex fallback + ASN/NDR extractors
│  ├─ normalize.ts        # normalizeTicketDecision (PO header safety gate)
│  ├─ local-classifier.ts # LocalClassifier — the LLM-less baseline behind Classifier
│  └─ text.ts             # findPoCode / findPartCodes / hasProcurementSignal
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

## Configuration

There is **no dotenv** — the code never reads a `.env` file. `src/config.ts`
reads `process.env` directly under plain Node (the mock, demo, and eval
scripts). Under Spin, `process.env` is **not** populated, so `src/index.ts`
overlays the same five values from `spin.toml`
`[component.scout-spin-worker.variables]` via `@spinframework/spin-variables`
(`get(key)` → the `fermyon:spin/variables` WIT import). `.env.example` is a
reference sheet only, not auto-loaded; set the variables inline or source it:

```bash
LLM_API_KEY=sk-... npm run eval -- ../maildrop/generator/output   # inline
set -a; . ./.env.example; set +a                                  # source all
```

| variable (Node env) | Spin key (lowercase) | default | notes |
|---|---|---|---|
| `LLM_API_KEY` | `llm_api_key` | *(empty)* | required to run the live classifier (eval / A/B) |
| `LLM_BASE_URL` | `llm_base_url` | `https://api.deepseek.com` | any OpenAI-compatible endpoint |
| `LLM_MODEL` | `llm_model` | `deepseek-chat` | |
| `TICKET_API_URL` | `ticket_api_url` | `http://localhost:8787` | local mock; point at the real Fastify API for the A/B run |
| `TICKET_API_KEY` | `ticket_api_key` | `dev-key` | org `x-api-key` sent to the ticket API |

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

maildrop emits the raw RFC822/MIME wire format — many `.eml` files (newer
versions also write a `manifest.json`, but that is only a generation report).
The ground-truth `kind` comes from the **filename**: `scenario-NN` maps onto
the boss's scenario number, hence onto `SCENARIO_KIND` (`01`→po_creation,
`02`→full_acknowledgement, `03`→partial_acknowledgement, `09`→line_exception,
`10`→asn). Older output that still carries `X-Labels`/`X-Po`/`X-Scenario`
headers is honoured as an override.

```bash
npm run eval:dry -- path/to/maildrop            # parse-only: print kind/po/labels/body, no LLM
npm run eval:dry -- path/to/maildrop --limit 5  # first N files only
npm run eval -- path/to/maildrop                # classify + score (needs LLM_API_KEY)
npm run eval -- path/to/maildrop --local        # deterministic baseline (no key; SOR's regex fallback)
```

`mock-api/maildrop/adapter.ts` hand-parses the MIME (RFC2047 subject, multipart
boundaries, quoted-printable/base64) with zero deps and turns each `.eml` into
the `InboundEmail` the pipeline consumes. It derives the ground-truth `kind`
from the filename (falling back to the older `X-Labels` header, where scenario
#9's `exception_with_counter` is mapped to `line_exception`), scrapes the
`PO-XXXXXXX` code out of the subject/body, and strips the older generator's
`[Scout Test … #N]` subject prefix + `Scout Test Case — …` body banner so the
classifier isn't handed the answer. `eval.ts` runs the `LlmClassifier` directly
(not the full pipeline) and scores the emitted `kind` against that derived
ground truth.

Two deliberate scope cuts:

- **No org/thread.** maildrop emails carry no org, so every email gets a fixed
  demo org and `threadId = messageId`; the org/thread resolver (layer 2) is out
  of scope for a classification eval.
- **Line-level correctness is not scored.** The scenario number gives a kind but
  not the expected part codes, so the eval builds a single synthetic PO (empty
  for `po_creation`, since a new PO is not on file yet) and leaves `lines` empty.
  Scoring `affectedPartCodes` / `modifications` would need the line-level labels.

## Run under Spin

`npm run build` (invoked by `spin build`) bundles `src/` with esbuild and
componentizes it into `dist/scout-spin-worker.wasm` via
`@spinframework/build-tools`' `SpinEsbuildPlugin` (+ jco) — the same pipeline
`spin new http-ts` scaffolds for SDK 4.x. `@spinframework/wasi-http-proxy` is a
side-effect polyfill (it exports `{}`) whose peer dependency pulls in
`build-tools`; `src/spin-globals.d.ts` declares the `addEventListener("fetch")`
pair.

```bash
npm install          # once (pulls esbuild + jco + build-tools + spin-variables)
spin build           # -> dist/scout-spin-worker.wasm
spin up              # serves http://localhost:3000/ (wildcard route)
curl http://localhost:3000/health    # -> {"ok":true}
curl -X POST http://localhost:3000/ -H 'content-type: application/json' -d '<InboundEmail>'
```

Verified against Spin 4.0.2 / the `@spinframework` SDK (esbuild + ComponentizeJS):

- `process.env` is **not** populated in the guest; config must come from
  `[component.scout-spin-worker.variables]` (plain `name = "default"` strings —
  the map form `{ default, required }` is application-level only and is not what
  the component resolves). Read them with `@spinframework/spin-variables`
  `get(key)`. Runtime injection does **not** override these either: neither
  `spin up --variable llm_api_key=...` nor `SPIN_VARIABLE_LLM_API_KEY=...`
  reaches a component-level `[variables]` entry, so the real key must be set by
  editing `spin.toml` (and restarting `spin up`). `git update-index
  --skip-worktree spin.toml` keeps that local edit out of git.
- `allowed_outbound_hosts` gates outbound `fetch`; the LLM and ticket API hosts
  are already allow-listed.
- `zod` works in the Spin JS runtime (no Node APIs needed for schema parsing).

Fixture caveat: POSTing the demo seeds to the Spin endpoint reproduces the
mock's hardcoded demo PO, whose status is `pending_ack`. Under the live LLM,
`seed-4-exception` therefore classifies as `pre_ack_modification` — a change to
a PO line that hasn't been acknowledged yet — rather than `line_exception`
(#9), which presupposes an already-acknowledged line. That is the LLM reasoning
about PO state correctly, not a classifier bug; it only surfaces on the demo
fixture. The maildrop eval exercises `line_exception` against real,
acknowledged-line emails and scores it there.

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

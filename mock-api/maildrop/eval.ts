// ---------------------------------------------------------------------------
// maildrop classification eval — batch-run a directory of .eml files through
// the LLM classifier and score the emitted kind against the X-Labels header.
//
// This is the A/B headline metric: given the same email corpus, does the
// prototype's classifier emit the same scenario kind the maildrop fixture was
// generated with? It does NOT exercise the HTTP/ticket-API boundary — that is
// demo.ts's job with the six hand-written seeds.
//
// Usage:
//   tsx mock-api/maildrop/eval.ts <dir>              # classify (needs LLM_API_KEY)
//   tsx mock-api/maildrop/eval.ts <dir> --local      # deterministic baseline (no key)
//   tsx mock-api/maildrop/eval.ts <dir> --dry-run    # just parse + print, no LLM
//   tsx mock-api/maildrop/eval.ts <dir> --limit 5    # only the first N files
//   MAILDROP_DIR=<dir> tsx mock-api/maildrop/eval.ts
//
// `--local` swaps in LocalClassifier — SOR's decideTicketLocally regex
// fallback — so the A/B harness can score the LLM-less baseline on the same
// corpus. Expect it to trail the LLM on the hard cases: the regex fallback is
// deliberately conservative and routes ambiguous reads to triage.
// ---------------------------------------------------------------------------

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { LocalClassifier } from "../../src/classifier/local-classifier";
import { LlmClassifier } from "../../src/classifier/llm";
import { loadConfig } from "../../src/config";
import type {
  ScoutCaseContext,
  ScoutMessage,
  ScoutPurchaseOrder,
  ScoutSupplierContact,
} from "../../src/contract/scout-context";
import { parseEml, type MaildropParsed } from "./adapter";

const DEFAULT_DIR = "./maildrop-samples";

/**
 * Build a case context for a single parsed email. Only the fields the
 * classifier's prompt reads are populated:
 *
 *   - the current message (subject / body / from / to) carries the email text;
 *   - purchaseOrders carries ONE synthetic PO when the ground-truth kind is NOT
 *     po_creation — a new PO is not on file yet at classification time, so a
 *     po_creation email gets an empty PO list, exactly like the real query.
 *
 * Lines are left empty: X-Labels gives a kind but not the expected part codes,
 * so line-level correctness (affectedPartCodes / modifications) is not scored
 * here. Extending this to line-level needs the maildrop JSON labels.
 */
function buildEvalContext(parsed: MaildropParsed): {
  context: ScoutCaseContext;
  currentMessage: ScoutMessage;
} {
  const email = parsed.email;
  const isNewPo = parsed.groundTruth.kind === "po_creation";
  const poCode = parsed.groundTruth.poCode;

  const message: ScoutMessage = {
    id: email.messageId,
    providerMessageId: email.messageId,
    messageIdHeader: email.messageId,
    subject: email.subject,
    bodyText: email.body,
    from: [{ email: email.from }],
    to: [{ email: email.to ?? "scout@demo.example" }],
    cc: [],
    receivedAt: email.receivedAt ?? null,
    // A po_creation email is the buyer sending a NEW PO — outbound, not a
    // supplier reply. The regex fallback keys po_creation on direction, so
    // leaving this inbound (as the harness originally did) silently shadows
    // every scenario-01 email into full_acknowledgement.
    direction: isNewPo ? "outbound" : "inbound",
    attachments: [],
    inboxUserId: "user-1",
    inboxProvider: "cloudflare",
  };

  const purchaseOrders: ScoutPurchaseOrder[] =
    !isNewPo && poCode
      ? [
          {
            poId: `po-${poCode}`,
            poCode,
            supplierCode: null,
            supplierName: null,
            status: "pending_ack",
            orderDate: null,
            ownerUserId: null,
            version: 1,
            updatedAt: null,
            lines: [],
          },
        ]
      : [];

  const supplierContacts: ScoutSupplierContact[] = [
    {
      contactId: "c-1",
      supplierCode: null,
      name: "Demo Contact",
      email: "contact@demo.example",
      phone: null,
      isPrimary: true,
      version: 1,
    },
  ];

  const context: ScoutCaseContext = {
    orgId: email.orgId,
    currentMessageId: email.messageId,
    memberUserIds: ["user-1"],
    thread: {
      id: email.threadId,
      providerThreadId: email.threadId,
      subject: email.subject,
      participants: [],
      messageCount: 1,
    },
    messages: [message],
    attachmentExtractions: [],
    purchaseOrders,
    supplierContacts,
    priorTickets: [],
    priorIngestion: [],
  };

  return { context, currentMessage: message };
}

function actualKind(decisions: Array<{ kind: string }>): string {
  return decisions.find((d) => d.kind !== "no_ticket")?.kind ?? decisions[0]?.kind ?? "no_ticket";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const local = args.includes("--local");

  let limit: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--limit") {
      limit = Number(args[i + 1]);
      i++;
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }
  const dir = positional[0] ?? process.env.MAILDROP_DIR ?? DEFAULT_DIR;

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => extname(f).toLowerCase() === ".eml").sort();
  } catch (err) {
    console.error(`Cannot read maildrop directory "${dir}": ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No .eml files in "${dir}". Usage: tsx mock-api/maildrop/eval.ts <dir> [--dry-run] [--limit N]`);
    process.exit(1);
  }
  if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
    files = files.slice(0, Math.floor(limit));
  }

  const parsedList: Array<{ file: string; parsed: MaildropParsed }> = [];
  for (const file of files) {
    parsedList.push({ file, parsed: parseEml(await readFile(join(dir, file), "utf8"), { filename: file }) });
  }

  console.log(`maildrop: ${parsedList.length} email(s) in ${dir}\n`);

  if (dryRun) {
    for (const { file, parsed } of parsedList) {
      const g = parsed.groundTruth;
      console.log(file);
      console.log(`  kind   : ${g.kind ?? "(none)"}`);
      console.log(`  po     : ${g.poCode ?? "(none)"}`);
      console.log(`  labels : ${g.labels.join(",") || "(none)"}`);
      console.log(`  subject: ${parsed.email.subject}`);
      console.log(`  body   : ${parsed.email.body.slice(0, 140).replace(/\s+/g, " ")}...`);
    }
    console.log(
      `\nDry run — parsed ${parsedList.length} email(s). Set LLM_API_KEY and rerun without --dry-run to classify.`,
    );
    return;
  }

  const classifier = local
    ? new LocalClassifier()
    : (() => {
        const config = loadConfig();
        if (!config.llm.apiKey) {
          console.error("LLM_API_KEY is not set. Set it to classify, or rerun with --dry-run to just parse or --local for the deterministic baseline.");
          process.exit(1);
        }
        return new LlmClassifier(config.llm);
      })();

  let correct = 0;
  const rows: Array<{ file: string; expected: string; actual: string; po: string | null; ok: boolean }> = [];

  for (const { file, parsed } of parsedList) {
    const { context, currentMessage } = buildEvalContext(parsed);
    const decisions = await classifier.classify({ context, currentMessage, channel: "scout_cc" });
    const actual = actualKind(decisions);
    const expected = parsed.groundTruth.kind ?? "(no label)";
    const ok = actual === expected;
    if (ok) correct += 1;
    rows.push({ file, expected, actual, po: parsed.groundTruth.poCode, ok });
  }

  for (const row of rows) {
    const mark = row.ok ? "PASS" : "FAIL";
    console.log(
      `${mark}  expected=${row.expected.padEnd(24)} actual=${row.actual.padEnd(24)} po=${row.po ?? "-"}  ${row.file}`,
    );
  }

  const byScenario = new Map<string, { total: number; correct: number }>();
  for (const row of rows) {
    const bucket = byScenario.get(row.expected) ?? { total: 0, correct: 0 };
    bucket.total += 1;
    if (row.ok) bucket.correct += 1;
    byScenario.set(row.expected, bucket);
  }
  console.log("\nBy scenario:");
  for (const [kind, bucket] of byScenario) {
    console.log(
      `  ${kind.padEnd(24)} ${bucket.correct}/${bucket.total} (${((bucket.correct / bucket.total) * 100).toFixed(1)}%)`,
    );
  }
  console.log(`\n${correct}/${rows.length} correct (${((correct / rows.length) * 100).toFixed(1)}%)`);
}

await main();

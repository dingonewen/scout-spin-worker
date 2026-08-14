// ---------------------------------------------------------------------------
// maildrop → InboundEmail adapter (test-side only).
//
// maildrop emits the RAW RFC822/MIME wire format — the same bytes Cloudflare
// Email Routing would hand to packages/cloudflare-worker. That worker (not the
// Spin component) is the MIME parser in production; here we reproduce just
// enough of it to turn a maildrop `.eml` into the InboundEmail the ticket
// pipeline consumes, and to pull the X-* headers out as ground-truth labels
// for the A/B scorer.
//
// What we fake on purpose: maildrop's emails carry no org/thread, so orgId is
// a fixed demo id and threadId defaults to the message id (mirroring
// computeThreadKey's fallback). The org/thread resolution is layer 2's job,
// out of scope for a classification eval.
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import type { InboundEmail } from "../../src/core/pipeline";

export type MaildropGroundTruth = {
  /** X-Scenario (e.g. "scenario-01"). */
  scenario: string | null;
  /** X-Index (the case number). */
  index: string | null;
  /** X-Po (the PO code the case is about). */
  poCode: string | null;
  /** X-Labels split on commas (e.g. ["po_creation","write_fact","erp_originated"]). */
  labels: string[];
  /** labels[0], normalized to the SOR ticket kind (see MAILDROP_KIND_ALIASES). */
  kind: string | null;
};

export type MaildropParsed = {
  email: InboundEmail;
  groundTruth: MaildropGroundTruth;
};

export type ParseEmlOptions = {
  /** orgId to stamp on every parsed email (default "org_demo"). */
  orgId?: string;
  /** threadId override (default: the message id). */
  threadId?: string;
  /** messageId fallback when the email has no Message-ID header. */
  fallbackMessageId?: string;
  /**
   * Strip the generator's synthetic label scaffolding — the `[Scout Test … #N]`
   * subject prefix and the `Scout Test Case — …` body banner. Default true:
   * production emails won't carry these, and leaving them leaks the answer
   * into the classifier (inflating the A/B score).
   */
  stripScaffolding?: boolean;
};

// maildrop's ML label for scenario #9 is "exception_with_counter"; SOR's
// ticket kind for the same case is "line_exception". Normalize so `kind`
// speaks the classifier's vocabulary and the A/B score is apples-to-apples.
const MAILDROP_KIND_ALIASES: Record<string, string> = {
  exception_with_counter: "line_exception",
};

type Headers = Map<string, string>;

export function parseEml(raw: string, options: ParseEmlOptions = {}): MaildropParsed {
  const { headers, body } = splitHeaderAndBody(raw);

  const messageId =
    extractAddress(headers.get("message-id") ?? "") || options.fallbackMessageId || "";

  const stripScaffolding = options.stripScaffolding ?? true;
  const rawSubject = decodeRfc2047(headers.get("subject") ?? "");
  const rawBody = extractTextBody(headers, body);
  const subject = stripScaffolding ? rawSubject.replace(/^\[Scout Test[^\]]*\]\s*/, "") : rawSubject;
  const bodyText = stripScaffolding ? rawBody.replace(/^Scout Test Case[^\n]*\n+/, "") : rawBody;

  const email: InboundEmail = {
    messageId,
    threadId: options.threadId ?? messageId,
    orgId: options.orgId ?? "org_demo",
    subject,
    body: bodyText,
    from: extractAddress(headers.get("from") ?? ""),
    to: extractAddress(headers.get("to") ?? "") || undefined,
    receivedAt: headers.get("date") ?? undefined,
  };

  const labels = (headers.get("x-labels") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const groundTruth: MaildropGroundTruth = {
    scenario: headers.get("x-scenario") ?? null,
    index: headers.get("x-index") ?? null,
    poCode: headers.get("x-po") ?? null,
    labels,
    kind: labels[0] ? (MAILDROP_KIND_ALIASES[labels[0]] ?? labels[0]) : null,
  };

  return { email, groundTruth };
}

// ---------------------------------------------------------------------------
// Header / body split (RFC 5322 + unfolded continuation lines).
// ---------------------------------------------------------------------------

function splitHeaderAndBody(raw: string): { headers: Headers; body: string } {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const normalized = noBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const splitAt = normalized.indexOf("\n\n");
  const headerBlock = splitAt === -1 ? normalized : normalized.slice(0, splitAt);
  const body = splitAt === -1 ? "" : normalized.slice(splitAt + 2);

  const headers = new Map<string, string>();
  let lastKey: string | null = null;
  for (const line of headerBlock.split("\n")) {
    if (/^[ \t]/.test(line) && lastKey) {
      // Folded continuation line — join onto the previous header's value.
      headers.set(lastKey, `${headers.get(lastKey) ?? ""} ${line.trim()}`);
    } else if (line.trim() !== "") {
      const match = line.match(/^([^:]+):[ \t]*(.*)$/);
      if (match) {
        lastKey = match[1]!.trim().toLowerCase();
        headers.set(lastKey, match[2] ?? "");
      } else {
        lastKey = null;
      }
    }
  }
  return { headers, body };
}

function extractAddress(value: string): string {
  const trimmed = value.trim();
  const angle = trimmed.match(/<([^>]*)>/);
  if (angle) return angle[1]!.trim();
  return trimmed;
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded-word decoding (both Q and B encodings).
// ---------------------------------------------------------------------------

function decodeRfc2047(value: string): string {
  if (!value) return value;
  // RFC 2047 §6.2: whitespace between adjacent encoded-words is not content.
  const collapsed = value.replace(
    /(=\?[^?]+\?[bBqQ]\?[^?]*\?=)[ \t]+(?==\?[^?]+\?[bBqQ]\?)/g,
    "$1",
  );
  return collapsed.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (word, charset: string, encoding: string, data: string) => {
      try {
        const bytes = encoding.toLowerCase() === "q" ? decodeQ(data) : Buffer.from(data, "base64");
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return word;
      }
    },
  );
}

function decodeQ(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "_") {
      bytes.push(0x20);
    } else if (c === "=" && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(0x3d); // literal "="
      }
    } else {
      bytes.push(c.charCodeAt(0));
    }
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// MIME body handling: pick the text/plain part, decode its transfer encoding.
// ---------------------------------------------------------------------------

function parseContentType(headers: Headers): { mime: string; boundary?: string } {
  const raw = headers.get("content-type") ?? "text/plain";
  const segments = raw.split(";");
  const mime = (segments[0] ?? "text/plain").trim().toLowerCase();
  let boundary: string | undefined;
  for (const segment of segments.slice(1)) {
    const match = segment.trim().match(/^boundary\s*=\s*"?([^";]+)"?$/i);
    if (match) boundary = match[1];
  }
  return { mime, boundary };
}

function extractTextBody(headers: Headers, body: string): string {
  const { mime, boundary } = parseContentType(headers);
  if (!mime.startsWith("multipart/")) {
    return decodeTransfer(headers, body);
  }
  if (!boundary) return body;

  let plain: string | null = null;
  let html: string | null = null;
  for (const part of splitParts(body, boundary).map(parsePart)) {
    const { mime: partMime } = parseContentType(part.headers);
    if (partMime === "text/plain" && plain === null) {
      plain = decodeTransfer(part.headers, part.body);
    } else if (partMime === "text/html" && html === null) {
      html = decodeTransfer(part.headers, part.body);
    } else if (partMime.startsWith("multipart/")) {
      const nested = extractTextBody(part.headers, part.body);
      if (nested && plain === null && html === null) plain = nested;
    }
  }
  return plain ?? html ?? "";
}

function splitParts(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] = [];
  let seen = false;
  for (const line of body.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === delimiter) {
      seen = true;
      if (current.length) parts.push(current.join("\n"));
      current = [];
    } else if (trimmed === `${delimiter}--`) {
      if (current.length) parts.push(current.join("\n"));
      current = [];
      break;
    } else if (seen) {
      current.push(line);
    }
  }
  if (current.length) parts.push(current.join("\n"));
  return parts;
}

function parsePart(part: string): { headers: Headers; body: string } {
  return splitHeaderAndBody(part);
}

function decodeTransfer(headers: Headers, body: string): string {
  const cte = (headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
  switch (cte) {
    case "base64":
      return decodeBase64(body);
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    default:
      return body;
  }
}

function decodeBase64(text: string): string {
  try {
    return new TextDecoder("utf-8").decode(Buffer.from(text.replace(/\s+/g, ""), "base64"));
  } catch {
    return "";
  }
}

function decodeQuotedPrintable(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "=") {
      if (text[i + 1] === "\n") {
        i++; // soft line break
        continue;
      }
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(c.charCodeAt(0));
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

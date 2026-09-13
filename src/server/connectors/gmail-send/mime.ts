/**
 * RFC 2822 / MIME assembly for the Gmail send connector.
 *
 * Message construction is kept pure and synchronous so it can be asserted
 * byte-for-byte in tests; the only IO in this module is `readAttachments`,
 * which pulls attachment bytes off disk at send time (they are never held in
 * the database).
 *
 * Every value that lands in a header position is either rejected (addresses,
 * subjects) or stripped (filenames) so a recruiter-supplied string cannot
 * smuggle an extra header — `Bcc:` injection is the whole threat model here.
 */

import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { OutboundEmailRequest } from "@domain";
import { AppError, badRequest } from "@server/infra/errors";

/** Gmail rejects any message whose total size exceeds 25MB. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CRLF = "\r\n";
/** RFC 2045 caps a base64 line at 76 characters. */
const BASE64_LINE_LENGTH = 76;
/** RFC 2822 caps a line at 998 characters excluding the CRLF. */
const MAX_LINE_LENGTH = 998;
/**
 * RFC 2047 caps an encoded word at 75 characters. 45 raw bytes encode to 60
 * base64 characters, leaving room for the 12-character `=?UTF-8?B??=` wrapper.
 */
const ENCODED_WORD_PAYLOAD_BYTES = 45;

export type LoadedAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

type MimePart = {
  headers: string[];
  content: string;
};

/** Gmail's `messages.send` takes the whole RFC 2822 message as base64url. */
export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function buildMimeMessage(
  request: OutboundEmailRequest,
  from: string,
  options: { attachments?: readonly LoadedAttachment[]; date?: Date } = {},
): string {
  const attachments = options.attachments ?? [];
  const declared = request.attachments?.length ?? 0;
  if (declared !== attachments.length) {
    throw badRequest(
      `Gmail send message declares ${declared} attachment(s) but ${attachments.length} were loaded; call readAttachments() first.`,
    );
  }

  assertNoCrlf(from, "sender");
  assertNoCrlf(request.to, "recipient");
  assertNoCrlf(request.subject, "subject");

  const to = request.to.trim();
  if (to === "") {
    throw badRequest("Gmail send requires a recipient address.");
  }

  const headers = [
    `From: ${from.trim()}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(request.subject)}`,
    // `toUTCString()` is RFC 1123 with the obsolete "GMT" zone; RFC 2822 wants
    // a numeric offset.
    `Date: ${(options.date ?? new Date()).toUTCString().replace(/ GMT$/, " +0000")}`,
    "MIME-Version: 1.0",
  ];

  const inReplyTo = normalizeMessageId(request.inReplyToMessageId);
  if (inReplyTo) {
    // Gmail only stitches a reply into the existing thread when both headers
    // are present, so they are emitted together or not at all.
    headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  }

  const textPart = buildTextPart(request.body);
  if (attachments.length === 0) {
    return [...headers, ...textPart.headers, "", textPart.content].join(CRLF);
  }

  const parts = [textPart, ...attachments.map(buildAttachmentPart)];
  const boundary = generateBoundary(parts);
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
  ];
  for (const part of parts) {
    lines.push(`--${boundary}`, ...part.headers, "", part.content);
  }
  lines.push(`--${boundary}--`, "");
  return lines.join(CRLF);
}

/**
 * Renders `Name <address>`, RFC 2047 encoding a non-ASCII display name.
 * Exported because the adapter owns the sender identity (it comes from the
 * connector config) while the quoting rules belong to this module.
 */
export function formatAddress(
  address: string,
  displayName?: string | null,
): string {
  assertNoCrlf(address, "sender address");
  const email = address.trim();
  if (email === "") {
    throw badRequest("Gmail send requires a sender address.");
  }

  const name = displayName?.trim() ?? "";
  if (name === "") return email;
  assertNoCrlf(name, "sender display name");

  return isPrintableAscii(name)
    ? `"${stripHeaderUnsafe(name)}" <${email}>`
    : `${encodeWord(name)} <${email}>`;
}

/**
 * Reads every declared attachment from disk, enforcing Gmail's total size cap
 * against the stat'd size before any bytes are loaded into memory. Throws
 * `badRequest` naming the offending path so the failure is actionable in the
 * agent trace.
 */
export async function readAttachments(
  request: OutboundEmailRequest,
): Promise<LoadedAttachment[]> {
  const declared = request.attachments ?? [];
  if (declared.length === 0) return [];

  const loaded: LoadedAttachment[] = [];
  let totalBytes = 0;

  for (const attachment of declared) {
    const path = attachment.path?.trim() ?? "";
    if (path === "") {
      throw badRequest(
        `Gmail send attachment "${attachment.filename}" is missing a file path.`,
      );
    }

    let content: Buffer;
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        throw badRequest(
          `Gmail send attachment path is not a regular file: ${path}.`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw badRequest(
          `Gmail send attachments total ${totalBytes} bytes, over the ${MAX_TOTAL_ATTACHMENT_BYTES} byte limit (last file: ${path}).`,
        );
      }
      content = await readFile(path);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw badRequest(
        `Gmail send attachment could not be read: ${path} (${describeFsError(error)}).`,
      );
    }

    loaded.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      content,
    });
  }

  return loaded;
}

function buildTextPart(body: string): MimePart {
  const normalized = (body ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .join(CRLF);

  if (isSevenBitSafe(normalized)) {
    return {
      headers: [
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 7bit",
      ],
      content: normalized,
    };
  }
  return {
    headers: [
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ],
    content: wrapBase64(Buffer.from(normalized, "utf8").toString("base64")),
  };
}

function buildAttachmentPart(attachment: LoadedAttachment): MimePart {
  const sanitized = sanitizeFilename(attachment.filename);
  // Quoted parameter values cannot be folded, so a non-ASCII filename becomes
  // one encoded word. RFC 2231 would be the purist answer; Gmail and every
  // mainstream client read the encoded-word form.
  const filename = isPrintableAscii(sanitized)
    ? sanitized
    : encodeWord(sanitized);
  const mimeType = sanitizeMimeType(attachment.mimeType);

  return {
    headers: [
      `Content-Type: ${mimeType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
    ],
    content: wrapBase64(attachment.content.toString("base64")),
  };
}

/**
 * A boundary must not appear anywhere inside the parts it delimits, otherwise
 * the message silently truncates at the collision. 24 hex characters make a
 * collision astronomically unlikely; the check makes it impossible.
 */
function generateBoundary(parts: readonly MimePart[]): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `cc-boundary-${randomBytes(12).toString("hex")}`;
    const collides = parts.some(
      (part) =>
        part.content.includes(candidate) ||
        part.headers.some((header) => header.includes(candidate)),
    );
    if (!collides) return candidate;
  }
  throw new Error("Unable to generate a collision-free MIME boundary.");
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += BASE64_LINE_LENGTH) {
    lines.push(value.slice(index, index + BASE64_LINE_LENGTH));
  }
  return lines.join(CRLF);
}

/** RFC 2047 encoded word, folded across several words when the text is long. */
function encodeSubject(value: string): string {
  if (isPrintableAscii(value)) return value;
  return chunkUtf8(value, ENCODED_WORD_PAYLOAD_BYTES)
    .map((chunk) => `=?UTF-8?B?${chunk.toString("base64")}?=`)
    .join(`${CRLF} `);
}

/** Single unfolded RFC 2047 encoded word, for headers that cannot fold. */
function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function chunkUtf8(value: string, maxBytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (currentBytes + size > maxBytes && current !== "") {
      chunks.push(Buffer.from(current, "utf8"));
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current !== "") chunks.push(Buffer.from(current, "utf8"));
  return chunks.length > 0 ? chunks : [Buffer.alloc(0)];
}

function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = stripHeaderUnsafe(value).replace(/\s+/g, "");
  const bare = stripped.replace(/^<+/, "").replace(/>+$/, "");
  return bare === "" ? null : `<${bare}>`;
}

/**
 * Removes the characters that could escape a quoted string: CR/LF (header
 * injection), the double quote itself, and the backslash (which would escape
 * the closing quote). Control characters go too.
 */
function stripHeaderUnsafe(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (char === '"' || char === "\\") continue;
    out += char;
  }
  return out;
}

function sanitizeFilename(filename: string): string {
  const cleaned = stripHeaderUnsafe(filename ?? "").trim();
  return cleaned === "" ? "attachment" : cleaned;
}

function sanitizeMimeType(mimeType: string): string {
  const cleaned = stripHeaderUnsafe(mimeType ?? "").replace(/[;,\s]/g, "");
  return /^[\w.+-]+\/[\w.+-]+$/.test(cleaned)
    ? cleaned
    : "application/octet-stream";
}

function assertNoCrlf(value: string, field: string): void {
  if (typeof value !== "string") {
    throw badRequest(`Gmail send ${field} must be a string.`);
  }
  if (value.includes("\r") || value.includes("\n")) {
    throw badRequest(
      `Gmail send ${field} must not contain CR or LF characters (header injection).`,
    );
  }
}

function isPrintableAscii(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function isSevenBitSafe(value: string): boolean {
  for (const line of value.split(CRLF)) {
    if (line.length > MAX_LINE_LENGTH) return false;
    for (const char of line) {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0x09) continue;
      if (code < 0x20 || code > 0x7e) return false;
    }
  }
  return true;
}

function describeFsError(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown error";
  }
  const code = String(error.code);
  if (code === "ENOENT") return "file not found";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EISDIR") return "path is a directory";
  return code;
}

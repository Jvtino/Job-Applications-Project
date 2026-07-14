/**
 * Minimal, dependency-free RFC822/MIME decoder for the email job-alert
 * ingestion module. Node built-ins only (`Buffer`). This is intentionally
 * best-effort: it exists solely to pull the text/html + text/plain bodies and
 * the From/Subject headers out of a LinkedIn/Indeed alert email the user has
 * exported to a file. It never touches the network and never persists content.
 */

export interface ParsedMessage {
  /** Header names are lowercased; values are unfolded + RFC2047-decoded. First occurrence wins. */
  headers: Map<string, string>;
  /** Decoded text/html body (empty string if none). */
  html: string;
  /** Decoded text/plain body (empty string if none). */
  text: string;
}

/**
 * Parse a single raw RFC822 message into headers + the html/text bodies.
 * Splits headers from body at the first blank line, unfolds continued header
 * lines, walks `multipart/*` on its `boundary=`, and decodes quoted-printable
 * and base64 parts. Best-effort UTF-8 (falls back to latin1 for 8859-1/1252).
 */
export function parseMessage(raw: string): ParsedMessage {
  const { headerText, body } = splitHeadersAndBody(raw);
  const headers = parseHeaders(headerText);
  const acc: { html?: string; text?: string } = {};
  collectBodies(headers, body, acc);
  return { headers, html: acc.html ?? '', text: acc.text ?? '' };
}

/**
 * Split an mbox file into its individual raw messages on the mbox "From_"
 * separator lines (lines beginning with `From `). Any preamble before the first
 * separator is ignored. Empty chunks are dropped.
 */
export function splitMbox(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const messages: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^From /.test(line)) {
      if (current !== null) messages.push(current.join('\n'));
      current = [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) messages.push(current.join('\n'));
  return messages.filter((m) => m.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function splitHeadersAndBody(raw: string): { headerText: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) {
    return { headerText: raw, body: '' };
  }
  return {
    headerText: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

function parseHeaders(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  const rawLines = headerText.split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of rawLines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      const last = unfolded[unfolded.length - 1] ?? '';
      unfolded[unfolded.length - 1] = last + ' ' + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!name) continue;
    const value = line.slice(idx + 1).trim();
    if (!headers.has(name)) headers.set(name, decodeEncodedWords(value));
  }
  return headers;
}

function collectBodies(
  headers: Map<string, string>,
  body: string,
  acc: { html?: string; text?: string },
): void {
  const ctype = headers.get('content-type') ?? 'text/plain';
  const { type, params } = parseContentType(ctype);

  if (type.startsWith('multipart/')) {
    const boundary = params.get('boundary');
    if (!boundary) return;
    for (const part of splitMultipart(body, boundary)) {
      const { headerText, body: partBody } = splitHeadersAndBody(part);
      const partHeaders = parseHeaders(headerText);
      collectBodies(partHeaders, partBody, acc);
    }
    return;
  }

  const cte = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  const decoded = decodeBody(body, cte, params.get('charset'));
  if (type === 'text/html') {
    if (acc.html === undefined) acc.html = decoded;
  } else if (type === 'text/plain') {
    if (acc.text === undefined) acc.text = decoded;
  }
  // Non-text parts (images, attachments, …) are ignored — we only want bodies.
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = '--' + boundary;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed === delimiter) {
      if (current !== null) parts.push(current.join('\n'));
      current = [];
      continue;
    }
    if (trimmed === delimiter + '--') {
      if (current !== null) parts.push(current.join('\n'));
      current = null;
      break;
    }
    if (current !== null) current.push(line);
  }
  return parts;
}

function parseContentType(value: string): { type: string; params: Map<string, string> } {
  const segments = value.split(';');
  const type = (segments[0] ?? '').trim().toLowerCase();
  const params = new Map<string, string>();
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (key) params.set(key, val);
  }
  return { type, params };
}

function decodeBody(body: string, cte: string, charset?: string): string {
  const enc = cte.trim().toLowerCase();
  if (enc === 'base64') return bufferToString(base64ToBuffer(body), charset);
  if (enc === 'quoted-printable') return bufferToString(qpToBuffer(body), charset);
  // 7bit / 8bit / binary / none: the JS string already holds the characters.
  return body;
}

function bufferToString(buf: Buffer, charset?: string): string {
  const cs = (charset ?? 'utf-8').toLowerCase();
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252' || cs === 'cp1252') {
    return buf.toString('latin1');
  }
  return buf.toString('utf8');
}

function qpToBuffer(input: string): Buffer {
  // Drop soft line breaks (`=` at end of line).
  const cleaned = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    if (code === 0x3d /* '=' */) {
      const hex = cleaned.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(code & 0xff);
  }
  return Buffer.from(bytes);
}

function base64ToBuffer(input: string): Buffer {
  const cleaned = input.replace(/[^A-Za-z0-9+/=]/g, '');
  return Buffer.from(cleaned, 'base64');
}

/** Minimal RFC2047 encoded-word decoder for header values (`=?charset?B/Q?text?=`). */
function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole: string, charset: string, enc: string, text: string) => {
      try {
        if (enc.toUpperCase() === 'B') {
          return bufferToString(base64ToBuffer(text), charset);
        }
        // Q-encoding: '_' means space, then quoted-printable hex.
        return bufferToString(qpToBuffer(text.replace(/_/g, ' ')), charset);
      } catch {
        return whole;
      }
    },
  );
}

// src/ingestion/extract-text.ts
//
// Master-resume text extraction. Supports PDF, DOCX (mammoth), and plain text/markdown.
// Output is raw text with REAL line breaks; structuring into facts happens in parse-resume.ts.
//
// PDF NOTE: unpdf's high-level extractText() concatenates the PDF's text runs and largely loses line
// structure, so a resume comes out as one giant line and section headings ("Experience", "Skills")
// never start a line — which makes the heuristic parser find nothing. Instead we read the positioned
// text items (PDF.js getTextContent, which unpdf exposes) and reconstruct lines from their x/y
// coordinates: cluster items into rows by baseline, order left-to-right, insert spaces on real gaps,
// and break paragraphs on big vertical jumps. extractText() stays as a fallback for odd PDFs.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

export interface ExtractedResume {
  path: string;
  format: "pdf" | "docx" | "text";
  text: string;
}

export const MAX_RESUME_BYTES = 8_000_000;

const FORMAT_BY_EXT = new Map<string, ExtractedResume["format"]>([
  [".pdf", "pdf"],
  [".docx", "docx"],
  [".txt", "text"],
  [".md", "text"],
]);

/** One positioned glyph run from PDF.js. transform = [a,b,c,d,e,f]; e=x, f=y (PDF space, y up). */
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

export async function extractResumeText(path: string): Promise<ExtractedResume> {
  const ext = extname(path).toLowerCase();
  const buf = await readFile(path);
  const out = await extractResumeTextFromBuffer(basename(path), buf);
  return { ...out, path, format: FORMAT_BY_EXT.get(ext) ?? out.format };
}

export async function extractResumeTextFromBuffer(
  filename: string,
  buffer: Uint8Array
): Promise<ExtractedResume> {
  const ext = validateResumeUpload(filename, buffer);
  const format = FORMAT_BY_EXT.get(ext)!;
  try {
    if (format === "pdf") {
      return readable({ path: filename, format, text: normalize(await extractPdf(buffer)) });
    }
    if (format === "docx") {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
      return readable({ path: filename, format, text: normalize(value) });
    }
    const text = Buffer.from(buffer).toString("utf8");
    return readable({ path: filename, format, text: normalize(text) });
  } catch (err) {
    if (err instanceof Error && /No readable text|empty|too short/i.test(err.message)) throw err;
    throw new Error(
      `Could not read "${filename}". The file may be corrupt, password-protected, or not a valid ${ext.toUpperCase()} resume.`
    );
  }
}

export function validateResumeUpload(filename: string, buffer: Uint8Array): string {
  const ext = extname(filename).toLowerCase();
  if (!FORMAT_BY_EXT.has(ext)) {
    throw new Error(`Unsupported file type "${ext || "(none)"}". Upload a PDF, DOCX, TXT, or MD resume.`);
  }
  if (buffer.byteLength === 0) throw new Error("The uploaded resume is empty.");
  if (buffer.byteLength > MAX_RESUME_BYTES) {
    throw new Error("The resume file is too large. Upload a file under 8 MB.");
  }
  return ext;
}

function readable(extracted: ExtractedResume): ExtractedResume {
  const compact = extracted.text.replace(/\s/g, "");
  if (!compact) {
    throw new Error(
      "No readable text was found in the resume. If this is an image-only scan, upload a text-based PDF, DOCX, TXT, or MD file."
    );
  }
  if (compact.length < 20) {
    throw new Error("The resume text is too short to parse. Upload a complete resume or paste the full text.");
  }
  return extracted;
}

/** Position-aware extraction with a flat-text fallback for PDFs we can't lay out. */
async function extractPdf(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(plainUint8Array(data));
  let structured = "";
  try {
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter(
        (it): it is PdfTextItem => typeof (it as PdfTextItem).str === "string" && Array.isArray((it as PdfTextItem).transform)
      );
      const pageText = reconstructLines(items);
      if (pageText.trim()) pages.push(pageText);
    }
    structured = pages.join("\n\n");
  } catch {
    structured = "";
  }
  // If layout reconstruction produced almost nothing (encrypted/odd PDF), fall back to the flat path.
  if (structured.replace(/\s/g, "").length >= 20) return structured;
  const { text } = await extractPdfText(pdf, { mergePages: true });
  return text;
}

function plainUint8Array(data: Uint8Array): Uint8Array {
  return data.constructor === Uint8Array ? data : Uint8Array.from(data);
}

/** A glyph run with its coordinates pulled out of the PDF transform matrix as plain numbers. */
interface Glyph {
  str: string;
  x: number; // left edge
  y: number; // baseline (PDF space, up-positive)
  w: number; // advance width
  fs: number; // font size (horizontal scale)
  h: number; // glyph height
}

function toGlyph(it: PdfTextItem): Glyph {
  const t = it.transform;
  return {
    str: it.str,
    x: t[4] ?? 0,
    y: t[5] ?? 0,
    w: it.width || 0,
    fs: Math.abs((t[0] ?? 0) || 10),
    h: Math.abs(it.height || (t[3] ?? 0) || 10),
  };
}

/** Rebuild readable lines from positioned glyph runs on one page, with two-column handling. */
function reconstructLines(items: PdfTextItem[]): string {
  const glyphs = items.filter((it) => it.str.length > 0).map(toGlyph);
  if (!glyphs.length) return "";

  const heights = glyphs.map((g) => g.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 10;
  const rowTol = Math.max(2, medianH * 0.5); // items within half a line-height share a row

  // Top-to-bottom: PDF y increases upward, so sort descending. Cluster into rows by comparing each
  // glyph to the row's RUNNING last y (lastY), not a fixed first-glyph anchor — so a line whose
  // baseline drifts (mixed font sizes, superscripts, inline icons) stays one row instead of splitting.
  // `y` keeps the row's top baseline for the paragraph-gap test below.
  const sorted = [...glyphs].sort((a, b) => b.y - a.y);
  const rows: { y: number; lastY: number; items: Glyph[] }[] = [];
  for (const g of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.lastY - g.y) <= rowTol) {
      row.items.push(g);
      row.lastY = g.y;
    } else {
      rows.push({ y: g.y, lastY: g.y, items: [g] });
    }
  }

  // Each row → 1 segment (full width) or 2 segments (split at a column gutter). Consecutive
  // two-segment rows form a band whose left column is emitted fully, then the right column — so a
  // two-column "skills" block reads as two clean lists instead of interleaved half-lines.
  const out: string[] = [];
  let band: { left: string[]; right: string[] } | null = null;
  let prevY: number | null = null;
  const flush = () => {
    if (!band) return;
    out.push(...band.left.filter(Boolean), ...band.right.filter(Boolean));
    band = null;
  };

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    const segs = rowSegments(row.items, medianH);
    if (segs.length === 2) {
      if (!band) band = { left: [], right: [] };
      band.left.push(segs[0]!);
      band.right.push(segs[1]!);
    } else {
      flush();
      if (prevY !== null && prevY - row.y > medianH * 1.8) out.push(""); // paragraph break
      if (segs[0]) out.push(segs[0]);
    }
    prevY = row.y;
  }
  flush();
  return out.join("\n");
}

/** Turn one row's x-sorted glyphs into text, splitting once at a column gutter if present. */
function rowSegments(rowItems: Glyph[], medianH: number): string[] {
  const gutter = Math.max(36, medianH * 4); // a gap this wide is a column boundary, not a word space
  let splitAt = -1;
  let widest = gutter;
  let prevEnd: number | null = null;
  rowItems.forEach((g, i) => {
    if (prevEnd !== null && g.x - prevEnd > widest) {
      widest = g.x - prevEnd;
      splitAt = i;
    }
    prevEnd = g.x + g.w;
  });
  if (splitAt > 0) {
    return [joinRow(rowItems.slice(0, splitAt)), joinRow(rowItems.slice(splitAt))];
  }
  const single = joinRow(rowItems);
  return single ? [single] : [];
}

/** Concatenate x-sorted glyphs into one line, inserting spaces only on real glyph gaps. */
function joinRow(rowItems: Glyph[]): string {
  let text = "";
  let prevEnd: number | null = null;
  for (const g of rowItems) {
    if (prevEnd !== null) {
      const gap = g.x - prevEnd;
      if (gap > g.fs * 0.25 && !text.endsWith(" ") && !g.str.startsWith(" ")) text += " ";
    }
    text += g.str;
    prevEnd = g.x + g.w;
  }
  return text.replace(/[ \t]+/g, " ").trim();
}

/** Normalize whitespace/line endings while preserving line breaks (sections matter). */
function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

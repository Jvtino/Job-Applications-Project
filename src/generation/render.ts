// src/generation/render.ts
//
// Render the structured resume / cover-letter models to ATS-friendly PDF and DOCX:
// single-column, real selectable text, standard fonts, NO tables or text-boxes (those break
// ATS parsers). Both formats are produced from the SAME model so they stay identical.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { CoverLetterModel, ResumeModel } from "./document-model";

// ---------------------------------------------------------------------------------------
// PDF layout helper (single column, wrapped text)
// ---------------------------------------------------------------------------------------

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 54; // 0.75in

class PdfWriter {
  private doc!: PDFDocument;
  private page!: PDFPage;
  private regular!: PDFFont;
  private bold!: PDFFont;
  private y = 0;

  async init(): Promise<void> {
    this.doc = await PDFDocument.create();
    this.regular = await this.doc.embedFont(StandardFonts.Helvetica);
    this.bold = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.addPage();
  }

  private addPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  private get contentWidth(): number {
    return PAGE_W - 2 * MARGIN;
  }

  private wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = trial;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  para(
    text: string,
    opts: { size?: number; bold?: boolean; align?: "left" | "center"; indent?: number; gapAfter?: number; gapBefore?: number } = {}
  ): void {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.regular;
    const indent = opts.indent ?? 0;
    const lineHeight = size * 1.32;
    if (opts.gapBefore) this.y -= opts.gapBefore;
    for (const line of this.wrap(text, font, size, this.contentWidth - indent)) {
      if (this.y - lineHeight < MARGIN) this.addPage();
      const lineWidth = font.widthOfTextAtSize(line, size);
      const x = opts.align === "center" ? MARGIN + (this.contentWidth - lineWidth) / 2 : MARGIN + indent;
      this.page.drawText(line, { x, y: this.y - size, size, font, color: rgb(0, 0, 0) });
      this.y -= lineHeight;
    }
    this.y -= opts.gapAfter ?? 2;
  }

  bullet(text: string, opts: { size?: number } = {}): void {
    const size = opts.size ?? 10.5;
    const lineHeight = size * 1.32;
    const bulletIndent = 14;
    const textIndent = bulletIndent + this.regular.widthOfTextAtSize("•  ", size);
    const lines = this.wrap(text, this.regular, size, this.contentWidth - textIndent);
    lines.forEach((line, i) => {
      if (this.y - lineHeight < MARGIN) this.addPage();
      if (i === 0) {
        this.page.drawText("•", { x: MARGIN + bulletIndent, y: this.y - size, size, font: this.regular, color: rgb(0, 0, 0) });
      }
      this.page.drawText(line, { x: MARGIN + textIndent, y: this.y - size, size, font: this.regular, color: rgb(0, 0, 0) });
      this.y -= lineHeight;
    });
  }

  hr(): void {
    this.y -= 2;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    this.y -= 6;
  }

  async bytes(): Promise<Buffer> {
    return Buffer.from(await this.doc.save());
  }
}

// ---------------------------------------------------------------------------------------
// PDF renderers
// ---------------------------------------------------------------------------------------

export async function renderResumePdf(m: ResumeModel): Promise<Buffer> {
  const w = new PdfWriter();
  await w.init();
  w.para(m.name, { size: 17, bold: true, align: "center", gapAfter: 1 });
  for (const line of m.contactLines) w.para(line, { size: 9.5, align: "center", gapAfter: 1 });
  w.hr();

  const section = (title: string) => w.para(title.toUpperCase(), { size: 11.5, bold: true, gapBefore: 6, gapAfter: 3 });

  if (m.summary) {
    section("Summary");
    w.para(m.summary);
  }
  if (m.experience.length) {
    section("Experience");
    for (const exp of m.experience) {
      w.para(exp.header, { bold: true, gapAfter: 1, gapBefore: 3 });
      for (const b of exp.bullets) w.bullet(b);
    }
  }
  if (m.education.length) {
    section("Education");
    for (const e of m.education) w.para(e);
  }
  if (m.skills.length) {
    section("Skills");
    w.para(m.skills.join(", "));
  }
  if (m.certifications.length) {
    section("Certifications");
    for (const c of m.certifications) w.bullet(c);
  }
  return w.bytes();
}

export async function renderCoverLetterPdf(m: CoverLetterModel): Promise<Buffer> {
  const w = new PdfWriter();
  await w.init();
  w.para(m.date, { gapAfter: 8 });
  w.para(m.recipient, { gapAfter: 8 });
  w.para(m.greeting, { gapAfter: 6 });
  for (const p of m.paragraphs) w.para(p, { gapAfter: 8 });
  w.para(m.closing, { gapBefore: 4, gapAfter: 2 });
  w.para(m.signature);
  return w.bytes();
}

// ---------------------------------------------------------------------------------------
// DOCX renderers
// ---------------------------------------------------------------------------------------

function docxParagraph(text: string, opts: { bold?: boolean; size?: number; align?: "left" | "center"; spacingBefore?: number; spacingAfter?: number } = {}): Paragraph {
  return new Paragraph({
    alignment: opts.align === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: opts.spacingBefore ?? 0, after: opts.spacingAfter ?? 60 },
    children: [new TextRun({ text, bold: opts.bold ?? false, size: (opts.size ?? 21), font: "Calibri" })],
  });
}

function docxBullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, size: 21, font: "Calibri" })],
  });
}

async function packDocx(children: Paragraph[]): Promise<Buffer> {
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

export async function renderResumeDocx(m: ResumeModel): Promise<Buffer> {
  const kids: Paragraph[] = [];
  kids.push(docxParagraph(m.name, { bold: true, size: 32, align: "center", spacingAfter: 20 }));
  for (const line of m.contactLines) kids.push(docxParagraph(line, { size: 18, align: "center", spacingAfter: 20 }));

  const section = (t: string) => kids.push(docxParagraph(t.toUpperCase(), { bold: true, size: 24, spacingBefore: 160, spacingAfter: 60 }));

  if (m.summary) {
    section("Summary");
    kids.push(docxParagraph(m.summary));
  }
  if (m.experience.length) {
    section("Experience");
    for (const exp of m.experience) {
      kids.push(docxParagraph(exp.header, { bold: true, spacingBefore: 80, spacingAfter: 20 }));
      for (const b of exp.bullets) kids.push(docxBullet(b));
    }
  }
  if (m.education.length) {
    section("Education");
    for (const e of m.education) kids.push(docxParagraph(e));
  }
  if (m.skills.length) {
    section("Skills");
    kids.push(docxParagraph(m.skills.join(", ")));
  }
  if (m.certifications.length) {
    section("Certifications");
    for (const c of m.certifications) kids.push(docxBullet(c));
  }
  return packDocx(kids);
}

export async function renderCoverLetterDocx(m: CoverLetterModel): Promise<Buffer> {
  const kids: Paragraph[] = [
    docxParagraph(m.date, { spacingAfter: 160 }),
    docxParagraph(m.recipient, { spacingAfter: 160 }),
    docxParagraph(m.greeting, { spacingAfter: 120 }),
    ...m.paragraphs.map((p) => docxParagraph(p, { spacingAfter: 160 })),
    docxParagraph(m.closing, { spacingBefore: 80, spacingAfter: 20 }),
    docxParagraph(m.signature),
  ];
  return packDocx(kids);
}

// ---------------------------------------------------------------------------------------
// Save helper
// ---------------------------------------------------------------------------------------

export interface SavedDocs {
  resumePdf: string;
  resumeDocx: string;
  coverLetterPdf: string;
  coverLetterDocx: string;
}

/** Save only the résumé files (PDF + DOCX) when the cover letter has been gated out. */
export async function saveResumeDocs(
  resume: ResumeModel,
  outDir: string,
  slug: string
): Promise<{ resumePdf: string; resumeDocx: string }> {
  await mkdir(outDir, { recursive: true });
  const paths = {
    resumePdf: join(outDir, `${slug}-resume.pdf`),
    resumeDocx: join(outDir, `${slug}-resume.docx`),
  };
  await Promise.all([
    writeFile(paths.resumePdf, await renderResumePdf(resume)),
    writeFile(paths.resumeDocx, await renderResumeDocx(resume)),
  ]);
  return paths;
}

export async function saveGeneratedDocs(
  resume: ResumeModel,
  coverLetter: CoverLetterModel,
  outDir: string,
  slug: string
): Promise<SavedDocs> {
  await mkdir(outDir, { recursive: true });
  const paths: SavedDocs = {
    resumePdf: join(outDir, `${slug}-resume.pdf`),
    resumeDocx: join(outDir, `${slug}-resume.docx`),
    coverLetterPdf: join(outDir, `${slug}-cover-letter.pdf`),
    coverLetterDocx: join(outDir, `${slug}-cover-letter.docx`),
  };
  await Promise.all([
    writeFile(paths.resumePdf, await renderResumePdf(resume)),
    writeFile(paths.resumeDocx, await renderResumeDocx(resume)),
    writeFile(paths.coverLetterPdf, await renderCoverLetterPdf(coverLetter)),
    writeFile(paths.coverLetterDocx, await renderCoverLetterDocx(coverLetter)),
  ]);
  return paths;
}

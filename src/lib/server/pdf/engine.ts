import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { amountInWords } from "@/lib/utils";

/**
 * A small A4 document engine on top of pdfkit, shared by the quotation and invoice PDFs so they carry one
 * design language: logo + company header, hairline rules, a ruled items table whose header repeats on every
 * page, a keep-together totals block, and a footer with company contacts and "Page x of y".
 *
 * Every block is MEASURED before it is drawn (heightOfString), and a block that does not fit moves to the next
 * page — nothing is clipped, overlapped or drawn outside the margins. Long unbroken words are wrapped by pdfkit.
 */

export const INK = "#18181B";
export const MUTED = "#6B7280";
export const RULE = "#D4D4D8";
export const SOFT = "#F8F9FB";
export const PANEL = "#F3F4F8";
export const ACCENT = "#BE123C"; // the app's rose, darkened for print
export const TINT = "#FFF1F2";

const PAGE = { w: 595.28, h: 841.89 };
const M = { l: 42, r: 42, t: 40, b: 46 };
export const CONTENT_W = PAGE.w - M.l - M.r;
const FOOT_Y = PAGE.h - 34;
const BOTTOM = PAGE.h - M.b;

const ASSETS = (...p: string[]) => path.join(process.cwd(), "assets", ...p);

/** "₹1,23,456.00" — Indian digit grouping, always two decimals. Falls back to "Rs." when the font has no rupee sign. */
export function inr(n: number, symbol = "₹"): string {
  const v = Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
  return `${symbol}${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-11-07 → "07 Nov 2026"; ISO timestamps are shown in IST. */
export function dmy(v: string | Date | null | undefined): string {
  if (!v) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(8, 10)} ${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}`;
  const d = new Date(typeof v === "string" ? v : v.getTime());
  if (Number.isNaN(d.getTime())) return "";
  const ist = new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
  return dmy(ist);
}

export interface PdfCompany {
  name: string;
  tagline?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  gstin?: string;
  logo?: string; // data URL from Settings (PNG/JPEG); the bundled mark is used otherwise
  signature?: string;
  signatoryName?: string;
}

function dataUrlImage(u?: string): Buffer | null {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(u ?? "");
  return m ? Buffer.from(m[2], "base64") : null;
}
let bundledLogo: Buffer | null | undefined;
function logoBuffer(c: PdfCompany): Buffer | null {
  const own = dataUrlImage(c.logo);
  if (own) return own;
  if (bundledLogo === undefined) {
    try { bundledLogo = fs.readFileSync(ASSETS("brand", "intense-logo-black.png")); } catch { bundledLogo = null; }
  }
  return bundledLogo;
}

export interface Col {
  key: string;
  title: string;
  w: number; // relative width
  align?: "left" | "right" | "center";
}

export class Pdf {
  readonly doc: PDFKit.PDFDocument;
  private chunks: Buffer[] = [];
  private fonts = { regular: "Helvetica", bold: "Helvetica-Bold" };
  readonly rupee: string;
  private pageNo = 0;
  private continuedTitle = "";
  y = M.t;

  constructor(private company: PdfCompany, meta: { title: string; subject: string }) {
    this.doc = new PDFDocument({ size: "A4", margins: { top: M.t, bottom: 0, left: M.l, right: M.r }, bufferPages: true, compress: true, info: { Title: meta.title, Subject: meta.subject, Author: company.name || "Intense Care", Producer: "Intense Care ERP" } });
    this.doc.on("data", (c: Buffer) => this.chunks.push(c));
    let rupeeOk = false;
    try {
      this.doc.registerFont("Inter", ASSETS("fonts", "Inter-Regular.otf"));
      this.doc.registerFont("Inter-Bold", ASSETS("fonts", "Inter-Bold.otf"));
      this.fonts = { regular: "Inter", bold: "Inter-Bold" };
      rupeeOk = true;
    } catch {
      /* bundled font missing — built-in Helvetica has no rupee sign, so "Rs." is printed instead */
    }
    this.rupee = rupeeOk ? "₹" : "Rs. ";
    this.doc.font(this.fonts.regular);
  }

  /* ----------------------------------------------------------------- text helpers */
  font(bold = false, size = 9.5, color = INK) {
    this.doc.font(bold ? this.fonts.bold : this.fonts.regular).fontSize(size).fillColor(color);
    return this.doc;
  }
  /** Height a text would take at width w with the CURRENT font settings. */
  h(text: string, w: number, opts: PDFKit.Mixins.TextOptions = {}): number {
    return this.doc.heightOfString(text, { width: w, lineGap: 2, ...opts });
  }
  money(n: number) { return inr(n, this.rupee); }

  /** Moves to a new page if `need` points do not fit. */
  ensure(need: number) {
    if (this.y + need > BOTTOM) this.newPage();
  }

  /* ----------------------------------------------------------------- pages */
  private contentStart() { return this.y; }

  /** Page 1: letterhead (logo left, company right), a heavy accent rule, then the title with the document number and date. */
  firstPageHeader(title: string, right: string[], opts: { draft?: boolean } = {}) {
    this.pageNo = 1;
    this.continuedTitle = title;
    this.draft = !!opts.draft;
    const d = this.doc;
    const logo = logoBuffer(this.company);
    const top = M.t;
    let lh = 36;
    if (logo) {
      try {
        const img = (d as unknown as { openImage: (b: Buffer) => { width: number; height: number } }).openImage(logo);
        const w = Math.min(160, (img.width / img.height) * 44);
        lh = w / (img.width / img.height);
        d.image(logo, M.l, top, { width: w });
      } catch { /* unreadable logo — the name on the right still identifies the company */ }
    }
    const cw = 260;
    const cx = PAGE.w - M.r - cw;
    let cy = top;
    this.font(true, 12, INK);
    d.text(this.company.name || "Intense Care", cx, cy, { width: cw, align: "right" });
    cy = d.y + 1;
    this.font(false, 8.2, MUTED);
    const lines = [this.company.tagline, this.company.address, [this.company.phone, this.company.email].filter(Boolean).join("  ·  "), this.company.website, this.company.gstin ? `GSTIN: ${this.company.gstin}` : ""].filter(Boolean) as string[];
    for (const l of lines) { d.text(l, cx, cy, { width: cw, align: "right", lineGap: 1.5 }); cy = d.y; }
    this.y = Math.max(top + lh, cy) + 8;
    d.rect(M.l, this.y, CONTENT_W, 2.6).fillColor(ACCENT).fill();
    this.y += 16;
    this.font(true, 23, ACCENT);
    d.text(title, M.l, this.y, { width: CONTENT_W - 190, lineGap: 0 });
    const titleBottom = d.y;
    let ry = this.y + 3;
    for (const r of right.filter(Boolean)) {
      this.font(true, 9.5, INK);
      d.text(r, PAGE.w - M.r - 190, ry, { width: 190, align: "right", lineBreak: false });
      ry += 14;
    }
    this.y = Math.max(titleBottom, ry) + 8;
  }
  draft = false;

  newPage() {
    this.doc.addPage();
    this.pageNo++;
    const d = this.doc;
    const logo = logoBuffer(this.company);
    let top = M.t;
    if (logo) { try { d.image(logo, M.l, top - 4, { height: 22 }); } catch { /* ignore */ } }
    this.font(true, 9, INK);
    d.text(`${this.continuedTitle} (continued)`, M.l + 120, top, { width: CONTENT_W - 120, align: "right" });
    top += 22;
    d.moveTo(M.l, top).lineTo(PAGE.w - M.r, top).lineWidth(0.8).strokeColor(RULE).stroke();
    this.y = top + 14;
    this.onNewPage?.();
  }
  onNewPage?: () => void;

  /* ----------------------------------------------------------------- blocks */
  heading(text: string) {
    this.ensure(34);
    this.font(true, 8.5, ACCENT);
    this.doc.text(text.toUpperCase(), M.l, this.y, { width: CONTENT_W, characterSpacing: 0.8 });
    this.y = this.doc.y + 4;
  }

  /**
   * Shaded rounded panels. `left` is a titled block of lines (name in bold); `right` is a key/value list (document details).
   * Blank lines and rows are never printed. The two panels share one height.
   */
  panels(left: { heading: string; lines: { text: string; bold?: boolean }[] } | null, right: { heading: string; rows: { label: string; value: string }[] } | null) {
    const PAD = 12;
    const rows = (right?.rows ?? []).filter((r) => r.value);
    const hasL = !!left && left.lines.length > 0, hasR = !!right && rows.length > 0;
    if (!hasL && !hasR) return;
    const gap = 14;
    const wl = hasL && hasR ? CONTENT_W * 0.54 : CONTENT_W;
    const wr = hasL && hasR ? CONTENT_W - wl - gap : CONTENT_W;
    let hl = 0, hr = 0;
    if (hasL) { hl = 16 + 12; for (const l of left!.lines) { this.font(!!l.bold, l.bold ? 10.5 : 9.2); hl += this.h(l.text, wl - PAD * 2) + 1.5; } }
    const vw = (hasL && hasR ? CONTENT_W - CONTENT_W * 0.54 - gap : CONTENT_W) * 0.6 - PAD;
    const rowH = rows.map((r) => { this.font(true, 9); return Math.max(14, this.h(r.value, vw) + 3); });
    if (hasR) { hr = 16 + 12 + rowH.reduce((a, b) => a + b, 0); }
    const H = Math.max(hl, hr) + PAD - 2;
    this.ensure(H + 12);
    const y0 = this.y;
    const box = (x: number, w: number) => this.doc.roundedRect(x, y0, w, H, 7).fillColor(PANEL).fill();
    if (hasL) {
      box(M.l, wl);
      this.font(true, 7.8, MUTED);
      this.doc.text(left!.heading.toUpperCase(), M.l + PAD, y0 + 10, { width: wl - PAD * 2, characterSpacing: 0.7 });
      let yy = this.doc.y + 5;
      for (const l of left!.lines) {
        this.font(!!l.bold, l.bold ? 10.5 : 9.2, l.bold ? INK : "#3F3F46");
        this.doc.text(l.text, M.l + PAD, yy, { width: wl - PAD * 2, lineGap: 1.5 });
        yy = this.doc.y + 1.5;
      }
    }
    if (hasR) {
      const x = hasL ? M.l + wl + gap : M.l;
      box(x, wr);
      this.font(true, 7.8, MUTED);
      this.doc.text(right!.heading.toUpperCase(), x + PAD, y0 + 10, { width: wr - PAD * 2, characterSpacing: 0.7 });
      let yy = y0 + 28;
      rows.forEach((r, i) => {
        this.font(false, 8.8, MUTED);
        this.doc.text(r.label, x + PAD, yy, { width: wr * 0.38, lineBreak: false });
        this.font(true, 9, INK);
        this.doc.text(r.value, x + wr * 0.4, yy, { width: wr * 0.6 - PAD, lineGap: 1 });
        yy += rowH[i];
      });
    }
    this.y = y0 + H + 8;
  }

  /** A full-width shaded panel (e.g. service location). */
  panel(heading: string, lines: { text: string; bold?: boolean }[]) {
    if (!lines.length) return;
    const PAD = 12;
    let H = 16 + 12;
    for (const l of lines) { this.font(!!l.bold, l.bold ? 10.5 : 9.2); H += this.h(l.text, CONTENT_W - PAD * 2) + 1.5; }
    H += PAD - 4;
    this.ensure(H + 12);
    const y0 = this.y;
    this.doc.roundedRect(M.l, y0, CONTENT_W, H, 7).fillColor(PANEL).fill();
    this.font(true, 7.8, MUTED);
    this.doc.text(heading.toUpperCase(), M.l + PAD, y0 + 10, { width: CONTENT_W - PAD * 2, characterSpacing: 0.7 });
    let yy = this.doc.y + 5;
    for (const l of lines) {
      this.font(!!l.bold, l.bold ? 10.5 : 9.2, l.bold ? INK : "#3F3F46");
      this.doc.text(l.text, M.l + PAD, yy, { width: CONTENT_W - PAD * 2, lineGap: 1.5 });
      yy = this.doc.y + 1.5;
    }
    this.y = y0 + H + 8;
  }

  /** Ruled table. The header row is drawn again at the top of every continuation page. */
  table(cols: Col[], rows: Record<string, string>[]) {
    const total = cols.reduce((a, c) => a + c.w, 0);
    const widths = cols.map((c) => (c.w / total) * CONTENT_W);
    const xs = widths.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? M.l) + w], [M.l]);
    const PADX = 6, PADY = 6;
    const header = () => {
      this.font(true, 8.5, "#FFFFFF");
      this.doc.rect(M.l, this.y, CONTENT_W, 23).fillColor(ACCENT).fill();
      cols.forEach((c, i) => {
        this.font(true, 8.5, "#FFFFFF");
        this.doc.text(c.title, xs[i] + PADX, this.y + 7.5, { width: widths[i] - PADX * 2, align: c.align ?? "left", lineBreak: false });
      });
      this.y += 23;
    };
    this.ensure(23 + 40);
    header();
    const prev = this.onNewPage;
    this.onNewPage = () => header();
    rows.forEach((r, idx) => {
      this.font(false, 9.5);
      const hh = Math.max(...cols.map((c, i) => this.h(r[c.key] ?? "", widths[i] - PADX * 2, { align: c.align ?? "left" }))) + PADY * 2;
      if (this.y + hh > BOTTOM) this.newPage(); // newPage re-draws the header via onNewPage
      if (idx % 2 === 1) this.doc.rect(M.l, this.y, CONTENT_W, hh).fillColor(SOFT).fill();
      cols.forEach((c, i) => {
        this.font(c.key === "desc" ? false : false, 9.5, INK);
        this.doc.text(r[c.key] ?? "", xs[i] + PADX, this.y + PADY, { width: widths[i] - PADX * 2, align: c.align ?? "left", lineGap: 2 });
      });
      // light ledger lines: left/right edges, column separators and the row's bottom rule
      this.doc.lineWidth(0.5).strokeColor(RULE);
      for (const x of xs) this.doc.moveTo(x, this.y).lineTo(x, this.y + hh).stroke();
      this.y += hh;
      this.doc.moveTo(M.l, this.y).lineTo(PAGE.w - M.r, this.y).stroke();
    });
    this.onNewPage = prev;
    this.y += 12;
  }

  /** Right-aligned totals box with an accent top rule; `strong` rows sit on a tinted band. Kept together on one page. */
  summary(rows: { label: string; value: string; strong?: boolean; muted?: boolean }[], opts: { note?: string; signature?: PdfCompany } = {}) {
    const w = 262, x = PAGE.w - M.r - w;
    const need = rows.reduce((a, r) => a + (r.strong ? 28 : 17), 0) + (opts.note ? 24 : 0) + 10;
    this.ensure(need);
    const y00 = this.y;
    if (opts.signature) this.signatureBeside(opts.signature, y00 + 6);
    this.doc.rect(x, this.y, w, 2).fillColor(ACCENT).fill();
    this.y += 4;
    rows.forEach((r, i) => {
      if (r.strong) {
        this.doc.rect(x, this.y, w, 26).fillColor(TINT).fill();
        this.font(true, 11, ACCENT);
        this.doc.text(r.label, x + 10, this.y + 8, { width: 130, lineBreak: false });
        this.doc.text(r.value, x + 100, this.y + 8, { width: w - 110, align: "right", lineBreak: false });
        this.y += 27;
      } else {
        if (i % 2 === 1) this.doc.rect(x, this.y - 3, w, 17).fillColor(SOFT).fill();
        this.font(false, 9.3, r.muted ? MUTED : INK);
        this.doc.text(r.label, x + 10, this.y, { width: 140, lineBreak: false });
        this.font(r.label.startsWith("Balance"), 9.3, r.muted ? MUTED : INK);
        this.doc.text(r.value, x + 100, this.y, { width: w - 110, align: "right", lineBreak: false });
        this.y += 17;
      }
    });
    if (opts.note) {
      this.font(false, 8, MUTED);
      this.doc.text(opts.note, x, this.y + 2, { width: w, align: "right" });
      this.y = this.doc.y + 6;
    }
    this.y += 4;
  }

  /** The company's signature, drawn to the left of the totals (invoices) so it never strands on its own page. */
  private signatureBeside(c: PdfCompany, y0: number) {
    const w = 200;
    this.font(true, 8.5, ACCENT);
    this.doc.text(`FOR ${(c.name || "Intense Care").toUpperCase()}`, M.l, y0, { width: w, characterSpacing: 0.8 });
    const sig = dataUrlImage(c.signature);
    if (sig) { try { this.doc.image(sig, M.l, y0 + 14, { fit: [140, 40] }); } catch { /* ignore */ } }
    this.doc.moveTo(M.l, y0 + 62).lineTo(M.l + w, y0 + 62).lineWidth(0.7).strokeColor(INK).stroke();
    this.font(false, 8.5, MUTED);
    this.doc.text(c.signatoryName || "Authorised signatory", M.l, y0 + 66, { width: w });
  }

  amountWords(total: number) {
    const words = amountInWords(total);
    if (!words) return;
    this.font(false, 9, MUTED);
    const text = `Amount in words: INR ${words} only. All amounts are in Indian rupees (INR).`;
    this.ensure(this.h(text, CONTENT_W) + 10);
    this.doc.text(text, M.l, this.y, { width: CONTENT_W, lineGap: 2 });
    this.y = this.doc.y + 8;
  }

  /** A titled paragraph block; splits across pages by paragraph so a long terms text never runs off the page. */
  section(title: string, text: string | undefined | null, opts: { size?: number; bullets?: boolean } = {}) {
    const body = (text ?? "").replace(/\r/g, "").trim();
    if (!body) return;
    const size = opts.size ?? 9;
    const paras = body.split(/\n+/).map((p) => p.trim()).filter(Boolean);
    this.font(false, size);
    const first = paras[0];
    this.ensure(26 + Math.min(this.h(opts.bullets ? `•  ${first}` : first, CONTENT_W - (opts.bullets ? 10 : 0)), 60));
    this.heading(title);
    for (const p of paras) {
      this.font(false, size, "#3F3F46");
      const t = opts.bullets ? `•  ${p}` : p;
      const hh = this.h(t, CONTENT_W);
      if (this.y + hh > BOTTOM) this.newPage();
      this.font(false, size, "#3F3F46"); // newPage drew the running header in bold
      this.doc.text(t, M.l, this.y, { width: CONTENT_W, lineGap: 2 });
      this.y = this.doc.y + 2;
    }
    this.y += 5;
  }

  /** Customer acceptance (left) and company signature (right), kept together. */
  signatures(opts: { acceptance: boolean; company: PdfCompany; ack?: string }) {
    const H = opts.acceptance ? 70 : 50;
    this.ensure(H + 6);
    const cw = (CONTENT_W - 30) / 2;
    const y0 = this.y + 6;
    const box = (x: number, title: string, draw?: (x: number) => void) => {
      this.font(true, 8.5, ACCENT);
      this.doc.text(title.toUpperCase(), x, y0, { width: cw, characterSpacing: 0.8 });
      draw?.(x);
      this.doc.moveTo(x, y0 + H - 22).lineTo(x + cw, y0 + H - 22).lineWidth(0.7).strokeColor(INK).stroke();
    };
    if (opts.acceptance) {
      box(M.l, "Customer acceptance", (x) => {
        this.font(false, 8.5, MUTED);
        this.doc.text(opts.ack ?? "I accept this quotation and its terms.", x, y0 + 16, { width: cw });
        this.doc.text("Name, signature & date", x, y0 + H - 18, { width: cw });
      });
    }
    box(M.l + cw + 30, `For ${opts.company.name || "Intense Care"}`, (x) => {
      const sig = dataUrlImage(opts.company.signature);
      if (sig) { try { this.doc.image(sig, x, y0 + 14, { fit: [140, H - 38] }); } catch { /* ignore */ } }
      this.font(false, 8.5, MUTED);
      this.doc.text(opts.company.signatoryName || "Authorised signatory", x, y0 + H - 18, { width: cw });
    });
    this.y = y0 + H + 6;
  }

  /** A pill-style status label. */
  badge(text: string, x: number, y: number, tone: "good" | "warn" | "bad" | "neutral") {
    const col = { good: "#047857", warn: "#B45309", bad: "#B91C1C", neutral: "#52525B" }[tone];
    this.font(true, 8, col);
    const w = this.doc.widthOfString(text, { characterSpacing: 0.6 }) + 16;
    this.doc.roundedRect(x, y, w, 17, 8.5).lineWidth(0.9).strokeColor(col).stroke();
    this.doc.text(text, x + 8, y + 5, { width: w, lineBreak: false, characterSpacing: 0.6 });
    return w;
  }

  /* ----------------------------------------------------------------- finish */
  /** Footer on every page ("Page x of y"), then the finished bytes. */
  async finish(footerNote: string): Promise<Buffer> {
    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      if (this.draft) {
        // faint diagonal DRAFT mark, centred on the page
        this.doc.save();
        this.doc.opacity(0.07).fillColor("#DC2626").font(this.fonts.bold).fontSize(120);
        this.doc.rotate(-35, { origin: [PAGE.w / 2, PAGE.h / 2] });
        this.doc.text("DRAFT", PAGE.w / 2 - 190, PAGE.h / 2 - 60, { width: 380, align: "center", lineBreak: false });
        this.doc.restore();
      }
      this.doc.moveTo(M.l, FOOT_Y - 8).lineTo(PAGE.w - M.r, FOOT_Y - 8).lineWidth(0.6).strokeColor(RULE).stroke();
      this.font(false, 7.5, MUTED);
      const line = [this.company.name, this.company.phone, this.company.email, this.company.website].filter(Boolean).join("   |   ");
      this.doc.text(line, M.l, FOOT_Y, { width: CONTENT_W - 70, lineBreak: false, ellipsis: true });
      this.doc.text(`Page ${i + 1} of ${range.count}`, PAGE.w - M.r - 70, FOOT_Y, { width: 70, align: "right", lineBreak: false });
      if (footerNote) this.doc.text(footerNote, M.l, FOOT_Y + 10, { width: CONTENT_W, lineBreak: false, ellipsis: true });
    }
    const done = new Promise<Buffer>((res) => this.doc.on("end", () => res(Buffer.concat(this.chunks))));
    this.doc.end();
    return done;
  }
}

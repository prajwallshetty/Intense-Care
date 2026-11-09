import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInvoicePdf, buildQuotePdf } from "../src/lib/server/pdf/documents";
import { inr, dmy } from "../src/lib/server/pdf/engine";
import { invoiceDetail, line, quoteDoc, settingsFixture } from "./pdf-fixtures";

const hasPoppler = spawnSync("pdftotext", ["-v"]).status === 0 || spawnSync("pdftotext", ["-v"]).error === undefined;
const text = (buf: Buffer) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-")), "x.pdf");
  fs.writeFileSync(f, buf);
  return execFileSync("pdftotext", ["-layout", f, "-"]).toString();
};
const pages = (buf: Buffer) => (buf.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length;
const long = "Complete deep cleaning of a three-bedroom apartment including kitchen degreasing, bathroom descaling and balcony glass. ".repeat(3);
const many = Array.from({ length: 60 }, (_, i) => line(`Item ${i + 1} ${i % 7 === 0 ? long : "Bathroom deep clean"}`, 1, 1000 + i));

test("money and dates are Indian-formatted", () => {
  assert.equal(inr(123456.5), "₹1,23,456.50");
  assert.equal(inr(0), "₹0.00");
  assert.equal(inr(1234.5, "Rs. "), "Rs. 1,234.50");
  assert.equal(dmy("2026-11-07"), "07 Nov 2026");
  assert.equal(dmy("2026-11-06T20:00:00Z"), "07 Nov 2026"); // IST
  assert.equal(dmy(null), "");
});

test("quotation PDF: valid file, one page, fonts embedded, short description", async () => {
  const buf = await buildQuotePdf(quoteDoc({ items: [line("Sofa shampooing", 1, 2500)], address: "12 MG Road, Bengaluru" }), settingsFixture);
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(pages(buf), 1);
  assert.ok(buf.length < 400_000, `size ${buf.length}`);
  if (!hasPoppler) return;
  const t = text(buf);
  for (const must of ["QUOTATION", "Quotation No.: QT-2627-00042", "07 Nov 2026", "30 Nov 2026", "Anita Rao", "12 MG Road, Bengaluru", "Sofa shampooing", "₹2,500.00", "CGST @ 9%", "SGST @ 9%", "₹2,950.00", "Grand total", "CUSTOMER ACCEPTANCE", "Page 1 of 1", "TERMS & CONDITIONS"]) assert.ok(t.includes(must), `missing "${must}"`);
  assert.ok(!t.includes("SECRET INTERNAL"), "internal notes must never be printed");
});

test("quotation PDF: Non-GST has no tax lines; blank fields are not printed", async () => {
  const buf = await buildQuotePdf(quoteDoc({ items: [line("Water tank cleaning", 1, 1800)], gst: false, email: "", phone: "" }), settingsFixture);
  if (!hasPoppler) return;
  const t = text(buf);
  assert.ok(!/CGST|SGST|IGST|GSTIN/.test(t), "no GST wording on a Non-GST quotation");
  assert.ok(t.includes("no GST") && !/Advance/.test(t));
  assert.ok(!t.includes("SERVICE LOCATION"), "no location panel when there is no address");
  assert.ok(!/Advance requested/.test(t));
  assert.ok(!/Discount/.test(t));
});

test("quotation PDF: long name, address and description wrap inside the page; advance and balance shown", async () => {
  const buf = await buildQuotePdf(quoteDoc({ items: [line(long, 2, 8999.5)], name: "Venkata Subramanyeswara Prasad Chaturvedi-Ramachandran the Third", address: "Flat 1204, Tower B, Prestige Lakeside Habitat, Whitefield Main Road, Varthur, Bengaluru 560087", discount: 500, advance: 5000, requirements: "Pets at home." }), settingsFixture);
  if (!hasPoppler) return;
  const t = text(buf);
  assert.ok(t.includes("Chaturvedi") && t.includes("Ramachandran"));
  assert.ok(t.includes("Advance requested") && t.includes("₹5,000.00") && t.includes("Balance after advance"));
  assert.ok(t.includes("ADDITIONAL REQUIREMENTS") && t.includes("Pets at home."));
  assert.ok(t.includes("Taxable amount"));
});

test("quotation PDF: many lines run onto more pages, the table header repeats, page numbers are right", async () => {
  const buf = await buildQuotePdf(quoteDoc({ items: many }), settingsFixture);
  const n = pages(buf);
  assert.ok(n >= 3, `pages ${n}`);
  if (!hasPoppler) return;
  const t = text(buf);
  assert.ok((t.match(/Service description/g) ?? []).length >= 2, "table header repeats on continuation pages");
  assert.ok(t.includes(`Page ${n} of ${n}`) && t.includes(`Page 1 of ${n}`));
  assert.ok(t.includes("(continued)"));
  for (let i = 1; i <= 60; i += 7) assert.ok(t.includes(`Item ${i}`), `item ${i} present`);
  assert.ok(t.includes("Item 60"), "last line present");
});

test("invoice PDF: GST breakdown, status, job and quotation reference, UPI, paid and balance", async () => {
  const buf = await buildInvoicePdf(invoiceDetail({ items: [line("Deep cleaning", 1, 8500), line("Sofa", 2, 1200)], paid: 3000, status: "PARTIAL" }), settingsFixture);
  assert.equal(pages(buf), 1);
  if (!hasPoppler) return;
  const t = text(buf);
  for (const must of ["TAX INVOICE", "Invoice No.: INV-2627-00007", "ANITA-RAO-07112026-001", "QT-2627-00042", "PARTIALLY PAID", "CGST @ 9%", "SGST @ 9%", "GSTIN: 29AAAAA0000A1Z5", "GSTIN: 29ABCDE1234F1Z5", "Amount paid", "₹3,000.00", "Balance due", "₹9,862.00", "intensecare@okhdfcbank", "Page 1 of 1"]) assert.ok(t.includes(must), `missing "${must}"`);
});

test("invoice PDF: Non-GST carries no GST data and an unpaid invoice never says paid", async () => {
  const buf = await buildInvoicePdf(invoiceDetail({ items: [line("Water tank cleaning", 1, 1800)], gst: false, status: "UNPAID", quoteNumber: null }), settingsFixture);
  if (!hasPoppler) return;
  const t = text(buf);
  assert.ok(!/CGST|SGST|IGST|GSTIN|SAC/.test(t), "Non-GST invoice has no GST fields");
  assert.ok(/INVOICE \(DRAFT\)/.test(t) && !t.includes("TAX INVOICE"));
  assert.ok(t.includes("UNPAID") && !/\bPAID\b/.test(t.replace("UNPAID", "")), "status shows UNPAID, never PAID");
  assert.ok(!t.includes("Quotation:"), "no quotation reference when none is linked");
});

test("invoice PDF: a paid invoice has no UPI request; many lines paginate", async () => {
  const paid = await buildInvoicePdf(invoiceDetail({ items: [line("Deep cleaning", 1, 1000)], paid: 1180, status: "PAID" }), settingsFixture);
  if (hasPoppler) {
    const t = text(paid);
    assert.ok(t.includes("PAID") && !t.includes("PAY BY UPI"));
  }
  const buf = await buildInvoicePdf(invoiceDetail({ items: many }), settingsFixture);
  assert.ok(pages(buf) >= 3);
  if (hasPoppler) assert.ok((text(buf).match(/Service description/g) ?? []).length >= 2);
});

import path from "node:path";
import fs from "node:fs/promises";
import ejs from "ejs";
import puppeteer from "puppeteer";

let browserPromise: ReturnType<typeof puppeteer.launch> | null = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  }
  return browserPromise;
}

/**
 * Renders the invoice PDF template (the same visual layout as the on-screen preview) to an
 * A4 PDF buffer via a headless Chromium instance, so the download and the preview never drift.
 */
export async function renderInvoicePdf(templateData: Record<string, unknown>): Promise<Buffer> {
  const templatePath = path.join(__dirname, "../../../views/invoices/pdf.ejs");
  const business = templateData.business as { logoPath?: string | null } | undefined;
  const html = await ejs.renderFile(templatePath, {
    ...templateData,
    business: business?.logoPath ? { ...business, logoPath: await inlineImage(business.logoPath) } : business,
  });

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };

/**
 * The PDF page is loaded via setContent (no base URL), so "/uploads/..." paths would not
 * resolve; embed the image as a data URI instead. Falls back to no logo if the file is missing.
 */
async function inlineImage(publicPath: string): Promise<string | null> {
  const publicDir = path.join(__dirname, "../../../public");
  const filePath = path.join(publicDir, publicPath);
  if (!filePath.startsWith(publicDir + path.sep)) return null;
  const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
  if (!mime) return null;
  try {
    const data = await fs.readFile(filePath);
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function closePdfBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

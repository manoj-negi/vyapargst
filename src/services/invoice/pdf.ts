import path from "node:path";
import fs from "node:fs/promises";
import ejs from "ejs";
import puppeteer from "puppeteer";

let browserPromise: ReturnType<typeof puppeteer.launch> | null = null;

async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser?.connected) return browser;
    browserPromise = null;
  }
  const launching = puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  browserPromise = launching;
  // Chromium can die (crash, OS sleep, killed process); drop the cached instance so the next call relaunches.
  launching
    .then((browser) => browser.once("disconnected", () => { if (browserPromise === launching) browserPromise = null; }))
    .catch(() => { if (browserPromise === launching) browserPromise = null; });
  return launching;
}

/**
 * Renders the invoice PDF template (the same visual layout as the on-screen preview) to an
 * A4 PDF buffer via a headless Chromium instance, so the download and the preview never drift.
 */
export async function renderInvoicePdf(templateData: Record<string, unknown>): Promise<Buffer> {
  const templatePath = path.join(__dirname, "../../../views/invoices/pdf.ejs");
  const business = templateData.business as { logoPath?: string | null; signaturePath?: string | null } | undefined;
  const stamp = templateData.stamp as { src: string } | null | undefined;
  const html = await ejs.renderFile(templatePath, {
    ...templateData,
    business: business
      ? {
          ...business,
          logoPath: business.logoPath ? await inlineImage(business.logoPath) : null,
          signaturePath: business.signaturePath ? await inlineImage(business.signaturePath) : null,
        }
      : business,
    // The PDF page has no base URL, so the stamp is embedded like the logo
    stamp: stamp ? { ...stamp, src: await inlineImage(stamp.src) } : null,
  });
  return renderHtmlToPdf(html);
}

/** Renders a complete HTML page to an A4 PDF; the page's own @page rule sets size and margins. */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    // Page size and margins come from the template's @page rule, shared with browser printing.
    const pdfBuffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
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

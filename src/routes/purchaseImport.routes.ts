import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireBusiness } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { INDIAN_STATES } from "../lib/indianStates";
import type { ActionContext } from "../services/documents/documentService";
import { SUPPORTED_SUMMARY } from "../services/purchaseImport/fileTypes";
import { LIMITS, libreOfficeAvailable } from "../services/purchaseImport/readers";
import { localStatus } from "../services/purchaseImport/localAi";
import { createImports, DOCS_DIR, discardImport, extractImport, getImport, remapTable, saveDraft, setRotation } from "../services/purchaseImport/service";
import { reviewDraft } from "../services/purchaseImport/review";
import { confirmImport } from "../services/purchaseImport/post";
import { DraftSchema } from "../services/purchaseImport/schema";
import { FIELD_LABELS, FIELDS } from "../services/purchaseImport/tableMapper";

export const purchaseImportRouter = Router();

// Any file type is accepted here: the type is decided from the content in createImports
const upload = multer({
  dest: path.join(os.tmpdir(), "citycart-imports"),
  limits: { fileSize: LIMITS.fileBytes, files: LIMITS.files },
});

const ctxFrom = (req: Request, res: Response): ActionContext => ({ business: res.locals.business, userId: req.session.userId });

function sendError(res: Response, err: unknown) {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) {
    return res.status(422).json({ error: err.code === "LIMIT_FILE_SIZE" ? `Each file can be at most ${LIMITS.fileBytes / 1024 / 1024} MB.` : err.code === "LIMIT_FILE_COUNT" ? `Upload at most ${LIMITS.files} files at a time.` : "The upload could not be read." });
  }
  throw err;
}

// ---------- Pages ----------
purchaseImportRouter.get("/purchases/import", requireBusiness, async (req, res) => {
  const business = res.locals.business;
  const imports = await prisma.purchaseImport.findMany({
    where: { businessId: business.id, status: { not: "DISCARDED" } },
    include: { files: { select: { originalName: true }, orderBy: { position: "asc" } }, purchase: { select: { id: true, invoiceNo: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.render("purchase-import/index", {
    title: "Import purchase bill",
    activeNav: "purchases",
    imports,
    services: await localStatus(),
    supported: SUPPORTED_SUMMARY,
    limits: LIMITS,
    libreOffice: await libreOfficeAvailable(),
  });
});

purchaseImportRouter.post("/purchases/import", requireBusiness, (req, res, next) => {
  upload.array("files", LIMITS.files)(req, res, async (err: unknown) => {
    try {
      if (err) return sendError(res, err);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const grouping = req.body?.grouping === "separate" ? "separate" : "one";
      const ids = await createImports(ctxFrom(req, res), files, grouping);
      res.json({ ids, redirect: ids.length === 1 ? `/purchases/import/${ids[0]}?scan=1` : "/purchases/import?uploaded=" + ids.length });
    } catch (e) {
      try { sendError(res, e); } catch (x) { next(x); }
    }
  });
});

purchaseImportRouter.get("/purchases/import/:id", requireBusiness, async (req, res) => {
  const business = res.locals.business;
  const imp = await getImport(business.id, req.params.id);
  const suppliers = await prisma.customer.findMany({
    where: { businessId: business.id, isActive: true, partyType: { in: ["SUPPLIER", "BOTH"] } },
    select: { id: true, name: true, gstin: true, state: true },
    orderBy: { name: "asc" },
  });
  res.render("purchase-import/review", {
    title: "Review imported bill",
    activeNav: "purchases",
    imp,
    suppliers,
    states: INDIAN_STATES,
    services: await localStatus(),
    fields: FIELDS.map((f) => ({ key: f, label: FIELD_LABELS[f] })),
  });
});

/** The original document, for signed-in users of this business only (never public) */
purchaseImportRouter.get("/purchases/import/:id/files/:fileId", requireBusiness, async (req, res) => {
  const imp = await getImport(res.locals.business.id, req.params.id);
  const file = imp.files.find((f) => f.id === req.params.fileId);
  if (!file) throw new AppError("File not found", 404);
  const full = path.join(DOCS_DIR, file.storedName);
  res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
  const inline = file.detectedType === "pdf" || ["jpeg", "png", "webp"].includes(file.detectedType);
  if (req.query.preview === "1" && ["jpeg", "png", "webp", "tiff", "heic"].includes(file.detectedType)) {
    // A browser-friendly JPEG with the chosen rotation (also for HEIC/TIFF, which browsers cannot show)
    try {
      const img = await sharp(fs.readFileSync(full), { failOn: "none" }).rotate().rotate(file.rotation).resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      return res.type("image/jpeg").send(img);
    } catch {
      return res.status(415).send("Preview not available for this image.");
    }
  }
  res.type(file.mimeType);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.originalName)}"`);
  fs.createReadStream(full).pipe(res);
});

// ---------- API (JSON) ----------
purchaseImportRouter.get("/api/purchase-imports/status", requireBusiness, async (_req, res) => {
  res.set("Cache-Control", "no-store").json(await localStatus());
});

purchaseImportRouter.post("/api/purchase-imports/:id/extract", requireBusiness, async (req, res) => {
  try {
    const imp = await extractImport(ctxFrom(req, res), req.params.id);
    res.json({ status: imp.status, error: imp.error, draft: imp.draft, sourceData: imp.sourceData, extractor: imp.extractor });
  } catch (e) {
    sendError(res, e);
  }
});

purchaseImportRouter.post("/api/purchase-imports/:id/review", requireBusiness, async (req, res) => {
  try {
    await getImport(res.locals.business.id, req.params.id);
    const parsed = DraftSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: "Some values are not valid." });
    res.json(await reviewDraft(res.locals.business, req.params.id, parsed.data));
  } catch (e) {
    sendError(res, e);
  }
});

purchaseImportRouter.put("/api/purchase-imports/:id/draft", requireBusiness, async (req, res) => {
  try {
    await saveDraft(ctxFrom(req, res), req.params.id, req.body);
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) {
    sendError(res, e);
  }
});

const remapSchema = z.object({ partIndex: z.number().int().min(0), headerRow: z.number().int().min(0), columns: z.record(z.string(), z.number().int().min(0).nullable()), draft: z.unknown() });
purchaseImportRouter.post("/api/purchase-imports/:id/remap", requireBusiness, async (req, res) => {
  try {
    const body = remapSchema.parse(req.body);
    const current = DraftSchema.parse(body.draft);
    res.json({ draft: await remapTable(ctxFrom(req, res), req.params.id, body.partIndex, body.headerRow, body.columns, current) });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(422).json({ error: "The column choice is not valid." });
    sendError(res, e);
  }
});

purchaseImportRouter.post("/api/purchase-imports/:id/files/:fileId/rotate", requireBusiness, async (req, res) => {
  try {
    await setRotation(res.locals.business.id, req.params.id, req.params.fileId, Number(req.body?.rotation) || 0);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

purchaseImportRouter.post("/api/purchase-imports/:id/confirm", requireBusiness, async (req, res) => {
  try {
    const result = await confirmImport(ctxFrom(req, res), req.params.id, req.body);
    req.session.flash = {
      type: "success",
      message: result.already ? "This bill was already saved." : result.purchaseId ? `Purchase saved${result.createdProducts ? ` with ${result.createdProducts} new item${result.createdProducts === 1 ? "" : "s"}` : ""}. Stock and the supplier balance are updated.` : `${result.createdProducts} item${result.createdProducts === 1 ? "" : "s"} created from the document (no purchase, no stock change).`,
    };
    res.json({ redirect: result.purchaseId ? `/purchases/${result.purchaseId}` : "/products" });
  } catch (e) {
    sendError(res, e);
  }
});

purchaseImportRouter.post("/purchases/import/:id/discard", requireBusiness, async (req, res) => {
  await discardImport(res.locals.business.id, req.params.id);
  req.session.flash = { type: "success", message: "Import discarded. Nothing was changed." };
  res.redirect("/purchases/import");
});


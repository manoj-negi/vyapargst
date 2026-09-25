import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

const logoStorage = multer.diskStorage({
  destination: path.join(__dirname, "../../public/uploads/logos"),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

export const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_LOGO_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PNG, JPEG, WEBP or SVG logos are allowed"));
    }
    cb(null, true);
  },
});

import { Router } from "express";
import * as businessController from "../controllers/business.controller";
import { requireAuth } from "../middleware/auth";
import { uploadLogo } from "../lib/upload";

export const businessRouter = Router();

businessRouter.get("/business/setup", requireAuth, businessController.showBusinessSetup);
businessRouter.post(
  "/business/setup",
  requireAuth,
  uploadLogo.single("logo"),
  businessController.saveBusinessSetup
);

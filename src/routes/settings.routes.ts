import { Router } from "express";
import * as settingsController from "../controllers/settings.controller";
import { requireBusiness } from "../middleware/auth";

export const settingsRouter = Router();

settingsRouter.use(requireBusiness);

settingsRouter.get("/settings/tax-master", settingsController.listTaxMaster);
settingsRouter.post("/settings/tax-master", settingsController.createTaxMaster);
settingsRouter.post("/settings/tax-master/:id/toggle", settingsController.toggleTaxMaster);

settingsRouter.get("/settings/hsn-master", settingsController.listHsnMaster);
settingsRouter.post("/settings/hsn-master", settingsController.createHsnMaster);
settingsRouter.post("/settings/hsn-master/:id/toggle", settingsController.toggleHsnMaster);

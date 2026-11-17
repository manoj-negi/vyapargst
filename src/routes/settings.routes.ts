import { Router } from "express";
import * as settingsController from "../controllers/settings.controller";
import { requireBusiness } from "../middleware/auth";

export const settingsRouter = Router();


settingsRouter.get("/settings/tax-master", requireBusiness, settingsController.listTaxMaster);
settingsRouter.post("/settings/tax-master", requireBusiness, settingsController.createTaxMaster);
settingsRouter.post("/settings/tax-master/:id/toggle", requireBusiness, settingsController.toggleTaxMaster);

settingsRouter.get("/settings/hsn-master", requireBusiness, settingsController.listHsnMaster);
settingsRouter.post("/settings/hsn-master", requireBusiness, settingsController.createHsnMaster);
settingsRouter.post("/settings/hsn-master/:id", requireBusiness, settingsController.updateHsnMaster);
settingsRouter.post("/settings/hsn-master/:id/delete", requireBusiness, settingsController.deleteHsnMaster);
settingsRouter.post("/settings/hsn-master/:id/toggle", requireBusiness, settingsController.toggleHsnMaster);

settingsRouter.get("/settings/documents", requireBusiness, settingsController.showDocumentSettings);
settingsRouter.post("/settings/documents", requireBusiness, settingsController.saveDocumentSettings);

settingsRouter.get("/settings/backup", requireBusiness, settingsController.showBackups);
settingsRouter.post("/settings/backup", requireBusiness, settingsController.createBackupNow);

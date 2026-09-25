import { Router } from "express";
import * as dashboardController from "../controllers/dashboard.controller";
import { requireBusiness } from "../middleware/auth";

export const dashboardRouter = Router();

dashboardRouter.get("/", requireBusiness, dashboardController.showDashboard);
dashboardRouter.get("/dashboard", requireBusiness, dashboardController.showDashboard);

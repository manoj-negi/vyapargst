import { Router } from "express";
import * as authController from "../controllers/auth.controller";

export const authRouter = Router();

authRouter.get("/login", authController.showLogin);
authRouter.post("/login", authController.login);
authRouter.post("/logout", authController.logout);

import { Router } from "express";
import * as productsController from "../controllers/products.controller";
import { requireBusiness } from "../middleware/auth";
import { uploadItemImage } from "../lib/upload";

export const productsRouter = Router();


productsRouter.get("/products", requireBusiness, productsController.listProducts);
productsRouter.get("/products/new", requireBusiness, productsController.showNewProduct);
productsRouter.post("/products", requireBusiness, uploadItemImage.single("image"), productsController.createProduct);
productsRouter.get("/products/:id/edit", requireBusiness, productsController.showEditProduct);
productsRouter.post("/products/:id", requireBusiness, uploadItemImage.single("image"), productsController.updateProduct);
productsRouter.post("/products/:id/delete", requireBusiness, productsController.deleteProduct);
productsRouter.post("/products/:id/adjust-stock", requireBusiness, productsController.adjustProductStock);

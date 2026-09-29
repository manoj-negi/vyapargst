import { Router } from "express";
import * as productsController from "../controllers/products.controller";
import { requireBusiness } from "../middleware/auth";
import { uploadItemImage } from "../lib/upload";

export const productsRouter = Router();

productsRouter.use(requireBusiness);

productsRouter.get("/products", productsController.listProducts);
productsRouter.get("/products/new", productsController.showNewProduct);
productsRouter.post("/products", uploadItemImage.single("image"), productsController.createProduct);
productsRouter.get("/products/:id/edit", productsController.showEditProduct);
productsRouter.post("/products/:id", uploadItemImage.single("image"), productsController.updateProduct);
productsRouter.post("/products/:id/delete", productsController.deleteProduct);

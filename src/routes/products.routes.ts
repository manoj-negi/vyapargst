import { Router } from "express";
import * as productsController from "../controllers/products.controller";
import { requireBusiness } from "../middleware/auth";

export const productsRouter = Router();

productsRouter.use(requireBusiness);

productsRouter.get("/products", productsController.listProducts);
productsRouter.get("/products/new", productsController.showNewProduct);
productsRouter.post("/products", productsController.createProduct);
productsRouter.get("/products/:id/edit", productsController.showEditProduct);
productsRouter.post("/products/:id", productsController.updateProduct);
productsRouter.post("/products/:id/delete", productsController.deleteProduct);

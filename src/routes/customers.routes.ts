import { Router } from "express";
import * as customersController from "../controllers/customers.controller";
import { requireBusiness } from "../middleware/auth";

export const customersRouter = Router();

customersRouter.get("/customers", requireBusiness, customersController.listCustomers);
customersRouter.get("/customers/new", requireBusiness, customersController.showNewCustomer);
customersRouter.post("/customers", requireBusiness, customersController.createCustomer);
customersRouter.get("/customers/:id", requireBusiness, customersController.showStatement);
customersRouter.get("/customers/:id/edit", requireBusiness, customersController.showEditCustomer);
customersRouter.post("/customers/:id", requireBusiness, customersController.updateCustomer);

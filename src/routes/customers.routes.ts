import { Router } from "express";
import * as customersController from "../controllers/customers.controller";
import { requireBusiness } from "../middleware/auth";

export const customersRouter = Router();

customersRouter.use(requireBusiness);

customersRouter.get("/customers", customersController.listCustomers);
customersRouter.get("/customers/new", customersController.showNewCustomer);
customersRouter.post("/customers", customersController.createCustomer);
customersRouter.get("/customers/:id/edit", customersController.showEditCustomer);
customersRouter.post("/customers/:id", customersController.updateCustomer);

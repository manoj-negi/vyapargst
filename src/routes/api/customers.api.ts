import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireBusiness } from "../../middleware/auth";
import { customerSchema, toCustomerData } from "../../controllers/customers.controller";

export const customersApiRouter = Router();

customersApiRouter.use(requireBusiness);

/** Quick-create used by the "New Customer" popup on the Sale Invoice form. */
customersApiRouter.post("/api/customers", async (req, res) => {
  const business = res.locals.business;
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.errors.map((e) => e.message) });
  }

  const customer = await prisma.customer.create({
    data: { businessId: business.id, ...toCustomerData(parsed.data) },
  });

  res.status(201).json({
    customer: { id: customer.id, name: customer.name, phone: customer.phone, state: customer.state },
  });
});

import { Router } from "express";
import type { DocType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireBusiness } from "../../middleware/auth";
import { customerSchema, toCustomerData } from "../../controllers/customers.controller";

export const customersApiRouter = Router();

customersApiRouter.use("/api", requireBusiness);

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
    customer: { id: customer.id, name: customer.name, phone: customer.phone, state: customer.state, section: customer.section, department: customer.department, partyType: customer.partyType },
  });
});

/**
 * Section and department suggestions for one customer, from values saved on its earlier documents
 * (most used first) and then its customer record. Older unclassified values are not suggested.
 */
customersApiRouter.get("/api/customers/:id/departments", async (req, res) => {
  const business = res.locals.business;
  const customer = await prisma.customer.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const where = { businessId: business.id, customerId: customer.id, docType: { in: ["SALE_INVOICE", "ESTIMATE", "CREDIT_NOTE"] as DocType[] } };
  const [sectionRows, departmentRows] = await Promise.all([
    prisma.saleInvoice.groupBy({ by: ["section"], where: { ...where, section: { not: null } }, _count: { _all: true }, _max: { invoiceDate: true } }),
    prisma.saleInvoice.groupBy({ by: ["department"], where: { ...where, department: { not: null }, legacySectionDepartment: false }, _count: { _all: true }, _max: { invoiceDate: true } }),
  ]);
  const byUse = (a: { _count: { _all: number }; _max: { invoiceDate: Date | null } }, b: typeof a) =>
    b._count._all - a._count._all || (b._max.invoiceDate?.getTime() ?? 0) - (a._max.invoiceDate?.getTime() ?? 0);
  const collect = (values: (string | null | undefined)[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const v = value?.trim();
      if (v && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        out.push(v);
      }
    }
    return out;
  };

  res.json({
    sections: collect([...sectionRows.sort(byUse).map((r) => r.section), customer.section]),
    departments: collect([...departmentRows.sort(byUse).map((r) => r.department), customer.department]),
  });
});

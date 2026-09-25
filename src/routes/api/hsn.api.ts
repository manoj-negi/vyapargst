import { Router } from "express";
import { searchHsn } from "../../services/hsn/hsnSearch";
import { requireBusiness } from "../../middleware/auth";

export const hsnApiRouter = Router();

hsnApiRouter.use(requireBusiness);

hsnApiRouter.get("/api/hsn/search", async (req, res) => {
  const q = (req.query.q as string) || "";
  const results = await searchHsn(q, res.locals.business.id);
  res.json({ results });
});

import { prisma } from "../../lib/prisma";

export interface HsnSuggestion {
  hsnCode: string;
  description: string;
  gstRate: number;
}

/**
 * Keyword-matches a free-text product name/description against the maintained HSN master
 * dataset. Never invents an HSN code — only returns rows that already exist in HSNMaster.
 * The GST rate returned is HSNMaster's own configured rate (itself sourced from Tax Master
 * at import time); callers must still let the user override it via the Tax Master dropdown.
 */
export async function searchHsn(
  query: string,
  businessId: string,
  limit = 5
): Promise<HsnSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const rows = await prisma.hSNMaster.findMany({
    where: {
      isActive: true,
      // businessId is nullable to allow a future shared/global HSN dataset; for now every row
      // is created scoped to a business (see settings.controller), so include null defensively.
      OR: [{ businessId }, { businessId: null }],
      AND: [
        {
          OR: [
            { description: { contains: trimmed, mode: "insensitive" } },
            { keywords: { contains: trimmed, mode: "insensitive" } },
            { hsnCode: { startsWith: trimmed } },
          ],
        },
      ],
    },
    take: limit,
    orderBy: { hsnCode: "asc" },
  });

  return rows.map((r) => ({
    hsnCode: r.hsnCode,
    description: r.description,
    gstRate: Number(r.gstRate),
  }));
}

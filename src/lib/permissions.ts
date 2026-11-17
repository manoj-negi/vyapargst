import type { Request, Response } from "express";

/**
 * Who may see purchase costs and profit. Today every signed-in user works in a business they own,
 * so this is the owner check; if staff accounts are added, give them an explicit profit permission
 * here rather than in the views. Enforced by the profit API, not only by hiding the panel.
 */
export function canViewProfit(req: Request, res: Response): boolean {
  const business = res.locals.business as { ownerId?: string } | undefined;
  return !!business && !!req.session.userId && business.ownerId === req.session.userId;
}

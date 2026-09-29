import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

/**
 * Ensures the logged-in user has a Business set up, and attaches it to res.locals
 * so every view can render the business name/logo without re-querying.
 */
export async function requireBusiness(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Scoped to the owner so a stale session can never show another user's business;
  // otherwise fall back to the user's first business.
  const business =
    (req.session.businessId
      ? await prisma.business.findFirst({
          where: { id: req.session.businessId, ownerId: req.session.userId },
          include: { settings: true },
        })
      : null) ??
    (await prisma.business.findFirst({
      where: { ownerId: req.session.userId },
      orderBy: { createdAt: "asc" },
      include: { settings: true },
    }));

  if (!business) {
    req.session.businessId = undefined;
    return res.redirect("/business/setup");
  }

  req.session.businessId = business.id;
  res.locals.business = business;
  next();
}

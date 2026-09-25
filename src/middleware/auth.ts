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

  let businessId = req.session.businessId;

  if (!businessId) {
    const business = await prisma.business.findFirst({
      where: { ownerId: req.session.userId },
      orderBy: { createdAt: "asc" },
    });
    if (!business) {
      return res.redirect("/business/setup");
    }
    businessId = business.id;
    req.session.businessId = businessId;
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { settings: true },
  });

  if (!business) {
    req.session.businessId = undefined;
    return res.redirect("/business/setup");
  }

  res.locals.business = business;
  next();
}

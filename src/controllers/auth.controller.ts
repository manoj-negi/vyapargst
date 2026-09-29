import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

export function showLogin(req: Request, res: Response) {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("auth/login", { title: "Login", error: null });
}

export async function login(req: Request, res: Response, next: NextFunction) {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(422).render("auth/login", {
      title: "Login",
      error: "Email and password are required.",
    });
  }

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!user || !valid) {
    return res.status(401).render("auth/login", {
      title: "Login",
      error: "Invalid email or password.",
    });
  }

  // Start a fresh session so nothing from a previous login (e.g. its businessId) carries over.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.userName = user.name;
    res.redirect("/dashboard");
  });
}

export function logout(req: Request, res: Response) {
  req.session.destroy(() => {
    res.redirect("/login");
  });
}

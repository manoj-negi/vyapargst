import type { NextFunction, Request, Response } from "express";

export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).render("errors/404", { title: "Not Found", path: req.path });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  const status = err instanceof AppError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Something went wrong";

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  if (req.headers.accept?.includes("application/json") || req.path.startsWith("/api/")) {
    return res.status(status).json({ error: message });
  }

  res.status(status).render("errors/error", { title: "Error", message, status });
}

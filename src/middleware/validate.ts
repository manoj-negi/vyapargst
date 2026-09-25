import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { AppError } from "./errorHandler";

/** Validates req.body against a zod schema and replaces it with the parsed (typed, coerced) value. */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      return next(new AppError(message, 422));
    }
    req.body = result.data;
    next();
  };
}

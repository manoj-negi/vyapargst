import path from "node:path";
import express from "express";
// Patches Express to forward rejected promises from async route handlers to errorHandler
// instead of crashing the process with an unhandled rejection. Must be imported before routes.
import "express-async-errors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

import { authRouter } from "./routes/auth.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { businessRouter } from "./routes/business.routes";
import { productsRouter } from "./routes/products.routes";
import { customersRouter } from "./routes/customers.routes";
import { invoicesRouter } from "./routes/invoices.routes";
import { settingsRouter } from "./routes/settings.routes";
import { productsApiRouter } from "./routes/api/products.api";
import { hsnApiRouter } from "./routes/api/hsn.api";
import { invoicesApiRouter } from "./routes/api/invoices.api";

export function createApp() {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "../views"));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../public")));

  const sessionPool = new Pool({ connectionString: env.databaseUrl });
  const PgSession = connectPgSimple(session);

  app.use(
    session({
      store: new PgSession({ pool: sessionPool, tableName: "session", createTableIfMissing: true }),
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: env.isProduction,
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    })
  );

  // Site-wide locals available to every EJS view without re-passing them from each controller.
  app.use((req, res, next) => {
    res.locals.userName = req.session.userName || "";
    if (req.session.flash) {
      res.locals.flash = req.session.flash;
      req.session.flash = undefined;
    }
    next();
  });

  app.use(authRouter);
  app.use(dashboardRouter);
  app.use(businessRouter);
  app.use(productsRouter);
  app.use(customersRouter);
  app.use(invoicesRouter);
  app.use(settingsRouter);
  app.use(productsApiRouter);
  app.use(hsnApiRouter);
  app.use(invoicesApiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import { purchaseImportRouter } from "./routes/purchaseImport.routes";
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
import { viewHelpers } from "./lib/viewHelpers";

import { authRouter } from "./routes/auth.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { businessRouter } from "./routes/business.routes";
import { productsRouter } from "./routes/products.routes";
import { customersRouter } from "./routes/customers.routes";
import { invoicesRouter } from "./routes/invoices.routes";
import { settingsRouter } from "./routes/settings.routes";
import { reportsRouter } from "./routes/reports.routes";
import { productsApiRouter } from "./routes/api/products.api";
import { hsnApiRouter } from "./routes/api/hsn.api";
import { invoicesApiRouter } from "./routes/api/invoices.api";
import { customersApiRouter } from "./routes/api/customers.api";

export function createApp() {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "../views"));
  Object.assign(app.locals, viewHelpers);

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  // Supplier documents from purchase imports are private: only served through /purchases/import/…
  app.use("/uploads/purchase-docs", (_req, res) => res.status(404).end());
  app.use(express.static(path.join(__dirname, "../public")));

  // Liveness check used by the mobile app's connection screen. No session, no data.
  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true });
  });

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

  // Requests sent by an in-page dialog (public/js/dialogs.js) want a JSON outcome instead of a
  // redirect, so the dialog can stay open and show the error when the action is refused.
  // Controllers are unchanged: an error flash + redirect becomes 422 { error }, anything else
  // becomes { redirect } and the flash is kept for the page the dialog then opens.
  app.use((req, res, next) => {
    if (req.get("X-Dialog") !== "1") return next();
    res.redirect = ((statusOrUrl: number | string, maybeUrl?: string) => {
      const url = typeof statusOrUrl === "string" ? statusOrUrl : maybeUrl ?? "/";
      const flash = req.session.flash;
      if (flash && flash.type === "danger") {
        req.session.flash = undefined;
        res.status(422).json({ error: flash.message });
        return;
      }
      res.json({ redirect: url });
    }) as typeof res.redirect;
    next();
  });

  // Site-wide locals available to every EJS view without re-passing them from each controller.
  app.use((req, res, next) => {
    res.locals.userName = req.session.userName || "";
    res.locals.fieldErrors = {};
    res.locals.currentPath = req.path;
    // The Android/iOS app (mobile-app/) appends this to its WebView user agent; pages then load the
    // native helpers. Only presentation depends on it, never permissions or data.
    res.locals.isNativeApp = /\bTheCityCartApp\//.test(req.get("User-Agent") || "");
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
  app.use(purchaseImportRouter); // before invoicesRouter, whose /purchases/:id would match /purchases/import
  app.use(invoicesRouter);
  app.use(reportsRouter);
  app.use(settingsRouter);
  app.use(productsApiRouter);
  app.use(hsnApiRouter);
  app.use(invoicesApiRouter);
  app.use(customersApiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

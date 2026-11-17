import type { CapacitorConfig } from "@capacitor/cli";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEnvironment } from "./config/environments.mjs";

/*
 * One config for every environment; MOBILE_ENV picks the backend (see config/environments.mjs and
 * README.md). Use the npm scripts (npm run android:emulator, ios:simulator, sync:device,
 * sync:production...), which set MOBILE_ENV for both the web build and `cap sync`.
 *
 * Why server.url: every screen of THE CITY CART is rendered by the backend (Express + EJS, with the
 * data filled in per request), so there is no standalone frontend bundle to package. The app opens
 * the same backend the website uses, which keeps one frontend and one set of business logic. The
 * packaged www/ folder holds the connection screen shown when the backend cannot be reached. The
 * Capacitor docs describe server.url as meant for live reload, so read "Store release" in README.md.
 */
// The Capacitor CLI runs from this folder
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const env = resolveEnvironment();

const config: CapacitorConfig = {
  appId: process.env.MOBILE_APP_ID || "com.thecitycart.billing",
  appName: process.env.MOBILE_APP_NAME || "THE CITY CART",
  webDir: "www",
  // Lets the backend know a page is inside the app, so it adds the native helpers (public/js/native.js)
  appendUserAgent: `TheCityCartApp/${pkg.version}`,
  backgroundColor: "#ffffff",
  loggingBehavior: env.development ? "debug" : "production",
  server: {
    url: env.serverUrl,
    cleartext: env.cleartext,
    errorPath: "offline.html",
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: env.development,
  },
  ios: {
    contentInset: "never",
    webContentsDebuggingEnabled: env.development,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 4000,
      launchAutoHide: true,
      backgroundColor: "#ffffff",
      showSpinner: false,
    },
    Keyboard: { resize: "native", resizeOnFullScreen: true },
    SystemBars: { insetsHandling: "native", initialViewportFitValueHint: "cover", style: "LIGHT" },
  },
};

export default config;

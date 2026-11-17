/**
 * Capacitor access for the shared website pages when they run inside the Android/iOS app.
 *
 * The app's screens are the website's own server-rendered pages (one frontend for both), so they
 * have no JavaScript bundler. This file is bundled by `npm run bridge` into
 * ../public/js/vendor/capacitor-bridge.js, which the layout loads only inside the app. It exposes
 * the Capacitor runtime and proxies for the native plugins this app ships (see package.json);
 * public/js/native.js uses them. On the website it is never loaded.
 */
import { Capacitor, registerPlugin, SystemBars } from "@capacitor/core";

const names = ["App", "Browser", "Filesystem", "Keyboard", "Share", "SplashScreen"] as const;

const plugins = Object.fromEntries(names.map((n) => [n, registerPlugin(n)])) as Record<(typeof names)[number], any>;

(window as any).CityCartNative = { Capacitor, plugins: { ...plugins, SystemBars }, version: 1 };

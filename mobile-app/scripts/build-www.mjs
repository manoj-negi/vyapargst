// Builds the packaged web folder (www/): the connection screen, the brand logo and config.js with
// the backend address for MOBILE_ENV. The business screens themselves come from the backend.
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvironment } from "../config/environments.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(root, "www");
const env = resolveEnvironment();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
await cp(path.join(root, "www-src"), www, { recursive: true });
await cp(path.join(root, "brand", "logo.png"), path.join(www, "logo.png"));
const config = { environment: env.name, serverUrl: env.serverUrl, development: env.development, version: pkg.version };
await writeFile(path.join(www, "config.js"), `window.CITY_CART_APP = ${JSON.stringify(config, null, 2)};\n`);
await writeFile(path.join(www, "env.json"), JSON.stringify(config, null, 2) + "\n");

// The connection pages must be self-contained: when Capacitor shows offline.html (server.errorPath)
// on Android, it serves only that one file, so separate CSS/JS/image files would not load and Retry
// would do nothing. Inline the stylesheet, config, script and logo into each page.
const css = await readFile(path.join(www, "connection.css"), "utf8");
const js = await readFile(path.join(www, "connection.js"), "utf8");
const logo = `data:image/png;base64,${(await readFile(path.join(www, "logo.png"))).toString("base64")}`;
const cfgJs = `window.CITY_CART_APP = ${JSON.stringify(config)};`;
for (const page of ["offline.html", "index.html"]) {
  let html = await readFile(path.join(www, page), "utf8");
  html = html
    .replace('<link rel="stylesheet" href="connection.css">', `<style>${css}</style>`)
    .replace('<script src="config.js"></script>', `<script>${cfgJs}</script>`)
    .replace('<script src="connection.js"></script>', `<script>${js}</script>`)
    .replace('src="logo.png"', `src="${logo}"`);
  if (/href="connection\.css"|src="(config|connection)\.js"|src="logo\.png"/.test(html)) throw new Error(`${page}: could not inline its assets`);
  await writeFile(path.join(www, page), html);
}
console.log(`www/ built for ${env.name} → ${env.serverUrl}${env.cleartext ? " (development HTTP allowed)" : ""}`);

// Which backend the app opens, per environment. Used by capacitor.config.ts and scripts/build-www.mjs.
//
//   android-emulator  http://10.0.2.2:<port>   10.0.2.2 is the emulator's alias for your Mac
//   ios-simulator     http://localhost:<port>  the simulator shares your Mac's network
//   device            http://<Mac's Wi-Fi IP>:<port>  a real phone on the same Wi-Fi; its own
//                     "localhost" is the phone itself, so it can never reach the Mac that way
//   production        MOBILE_PRODUCTION_URL, which must be https
//
// Overrides: MOBILE_DEV_PORT (default 3000), MOBILE_DEV_HOST (the Mac's IP for "device"),
// MOBILE_DEV_URL (full URL for any development environment).
import os from "node:os";

export const ENVIRONMENT_NAMES = ["android-emulator", "ios-simulator", "device", "production"];

/** The Mac's IPv4 address on the local network (Wi-Fi/Ethernet), for testing on a real phone. */
export function lanAddress(interfaces = os.networkInterfaces()) {
  const preferred = ["en0", "en1"];
  const all = Object.entries(interfaces).flatMap(([name, addrs]) => (addrs || []).map((a) => ({ name, ...a })));
  const v4 = all.filter((a) => (a.family === "IPv4" || a.family === 4) && !a.internal);
  const pick = v4.find((a) => preferred.includes(a.name)) || v4.find((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)) || v4[0];
  return pick ? pick.address : null;
}

function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?)/.test(host) || host.endsWith(".local");
}

export function resolveEnvironment(name = process.env.MOBILE_ENV, env = process.env, interfaces) {
  const envName = name || "android-emulator";
  if (!ENVIRONMENT_NAMES.includes(envName)) {
    throw new Error(`Unknown MOBILE_ENV "${envName}". Use one of: ${ENVIRONMENT_NAMES.join(", ")}`);
  }
  const port = env.MOBILE_DEV_PORT || "3000";
  let serverUrl;
  if (envName === "production") {
    serverUrl = env.MOBILE_PRODUCTION_URL;
    if (!serverUrl) throw new Error("Set MOBILE_PRODUCTION_URL (for example https://billing.example.com) to build the production app.");
    const u = new URL(serverUrl);
    if (u.protocol !== "https:") throw new Error("MOBILE_PRODUCTION_URL must use https; the production app never allows unencrypted traffic.");
    if (isPrivateHost(u.hostname)) throw new Error("MOBILE_PRODUCTION_URL must be a public address, not a local one.");
  } else if (env.MOBILE_DEV_URL) {
    serverUrl = env.MOBILE_DEV_URL;
  } else if (envName === "android-emulator") {
    serverUrl = `http://10.0.2.2:${port}`;
  } else if (envName === "ios-simulator") {
    serverUrl = `http://localhost:${port}`;
  } else {
    const host = env.MOBILE_DEV_HOST || lanAddress(interfaces);
    if (!host) throw new Error("Could not find this Mac's Wi-Fi address. Connect to Wi-Fi or set MOBILE_DEV_HOST=192.168.x.x");
    serverUrl = `http://${host}:${port}`;
  }
  const url = new URL(serverUrl);
  const origin = url.origin;
  return {
    name: envName,
    serverUrl: origin,
    host: url.host,
    development: envName !== "production",
    // Unencrypted HTTP only for development builds against a local backend
    cleartext: envName !== "production" && url.protocol === "http:",
  };
}

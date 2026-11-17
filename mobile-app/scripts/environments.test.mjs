import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEnvironment, lanAddress } from "../config/environments.mjs";

const wifi = { lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }], en0: [{ family: "IPv4", address: "192.168.1.42", internal: false }] };

test("each development environment points at the Mac the right way", () => {
  assert.equal(resolveEnvironment("android-emulator", {}).serverUrl, "http://10.0.2.2:3000");
  assert.equal(resolveEnvironment("ios-simulator", {}).serverUrl, "http://localhost:3000");
  assert.equal(resolveEnvironment("device", {}, wifi).serverUrl, "http://192.168.1.42:3000");
  assert.equal(resolveEnvironment("device", { MOBILE_DEV_HOST: "10.0.0.5", MOBILE_DEV_PORT: "4000" }, wifi).serverUrl, "http://10.0.0.5:4000");
  assert.equal(resolveEnvironment("android-emulator", {}).cleartext, true);
});

test("production requires a public https address and never allows cleartext", () => {
  const p = resolveEnvironment("production", { MOBILE_PRODUCTION_URL: "https://billing.example.com/" });
  assert.equal(p.serverUrl, "https://billing.example.com");
  assert.equal(p.cleartext, false);
  assert.equal(p.development, false);
  assert.throws(() => resolveEnvironment("production", {}), /MOBILE_PRODUCTION_URL/);
  assert.throws(() => resolveEnvironment("production", { MOBILE_PRODUCTION_URL: "http://billing.example.com" }), /https/);
  assert.throws(() => resolveEnvironment("production", { MOBILE_PRODUCTION_URL: "https://192.168.1.5" }), /public/);
  assert.throws(() => resolveEnvironment("staging", {}), /Unknown MOBILE_ENV/);
});

test("finds the Wi-Fi address and ignores loopback", () => {
  assert.equal(lanAddress(wifi), "192.168.1.42");
  assert.equal(lanAddress({ lo0: wifi.lo0 }), null);
});

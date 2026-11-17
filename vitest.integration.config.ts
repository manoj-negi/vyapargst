import { defineConfig } from "vitest/config";

const testDb = process.env.TEST_DATABASE_URL ?? "";

export default defineConfig({
  test: {
    include: ["src/**/*.itest.ts"],
    // One database, so files run one after another
    fileParallelism: false,
    testTimeout: 60000,
    env: { DATABASE_URL: testDb, SESSION_SECRET: "integration-test" },
    setupFiles: ["src/test/integrationSetup.ts"],
  },
});

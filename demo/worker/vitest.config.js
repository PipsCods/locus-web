// Tests run inside workerd (the Workers runtime) with a local D1 that has the migrations applied.
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, SIGNING_SECRET: "test-secret-test-secret-test-secret-0123" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.js"] },
  };
});

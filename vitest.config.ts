import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { SECRET: "testsecret", POST_TOKEN: "testpost", PING_SECONDS: "1" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});

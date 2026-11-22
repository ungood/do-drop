import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { OWNER_PASSWORD: "testpassword", PING_SECONDS: "1" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});

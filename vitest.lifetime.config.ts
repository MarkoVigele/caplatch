import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          CAP_CENTS: "10",
          PERIOD: "lifetime",
        },
      },
    }),
  ],
  test: {
    include: ["test/lifetime.test.ts"],
    fileParallelism: false,
    reporters: ["verbose"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

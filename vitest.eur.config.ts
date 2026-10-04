import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { FIXTURE_OPENROUTER_KEY } from "./test/fixture.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          CAP_CENTS: "100",
          CURRENCY: "eur",
          PERIOD: "month",
          UPSTREAM_ENABLED: "true",
          OPENROUTER_API_KEY: FIXTURE_OPENROUTER_KEY,
        },
      },
    }),
  ],
  test: {
    include: ["test/eur.test.ts"],
    fileParallelism: false,
    reporters: ["verbose"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

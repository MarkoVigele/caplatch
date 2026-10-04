import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { FIXTURE_GATE_TOKEN, FIXTURE_OPENROUTER_KEY } from "./test/fixture.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          CAP_CENTS: "10",
          PERIOD: "month",
          UPSTREAM_ENABLED: "true",
          OPENROUTER_API_KEY: FIXTURE_OPENROUTER_KEY,
          GATE_TOKEN: FIXTURE_GATE_TOKEN,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/lifetime.test.ts",
      "test/eur.test.ts",
      "test/currency-refuse.test.ts",
      "test/gate-closed.test.ts",
    ],
    fileParallelism: false,
    reporters: ["verbose"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { FIXTURE_OPENROUTER_KEY } from "./test/fixture.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          CAP_CENTS: "1000",
          PERIOD: "month",
          UPSTREAM_ENABLED: "true",
          OPENROUTER_API_KEY: FIXTURE_OPENROUTER_KEY,
        },
      },
    }),
  ],
  test: {
    include: ["test/gate-closed.test.ts"],
    fileParallelism: false,
    reporters: ["verbose"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import("./src/ledger").SpendLedger>;
    CAP_CENTS: string;
    PERIOD: string;
    /**
     * Absent or "usd": CAP_CENTS is already US cents.
     * "eur": CAP_CENTS are euro-cents, converted at 110 US cents per euro.
     */
    CURRENCY?: string;
    /** "true" forwards to OpenRouter after a reservation. Any other value stays off. */
    UPSTREAM_ENABLED: string;
    /** Worker secret. Not a wrangler var. Absent until the installer sets it. */
    OPENROUTER_API_KEY?: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./src/index");
    durableNamespaces: "SpendLedger";
  }
}

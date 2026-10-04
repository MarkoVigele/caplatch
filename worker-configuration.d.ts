declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import("./src/ledger").SpendLedger>;
    CAP_CENTS: string;
    PERIOD: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./src/index");
    durableNamespaces: "SpendLedger";
  }
}

import type { PaymentsMode } from "@trato/shared";

/** Bindings, vars and secrets of the Worker (kept manual: secrets are not in wrangler.jsonc). */
export interface AppEnv {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  ASSETS: Fetcher;
  RL_PUBLIC_READ: RateLimit;
  RL_PUBLIC_WRITE: RateLimit;
  PAYMENTS_MODE: PaymentsMode;
  PUBLIC_APP_URL: string;
  PEY_BASE_URL: string;
  /** Secrets (wrangler secret put / .dev.vars). */
  PEY_API_KEY: string;
  PEY_WEBHOOK_SECRET: string;
  SESSION_SECRET: string;
  DEMO_SELLER_PIN: string;
}

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }
}

export interface AccessContext {
  agreementId: string;
  tokenHash: string;
}

export interface AppVariables {
  /** Seller id from a valid session cookie (set by `sessionOptional` / `requireSeller`). */
  sellerId: string | null;
  /** Set by `resolveToken` on public routes. */
  access: AccessContext;
}

export type HonoEnv = { Bindings: AppEnv; Variables: AppVariables };

import type {
  PeyBankAccount,
  PeyCreatePnRequest,
  PeyCreatePnResponse,
  PeyCreateQrRequest,
  PeyCreateQrResponse,
  PeyQrTransactionsResponse,
  PeyTransaction,
} from "@trato/shared";
import type { AppEnv } from "../env";
import { LivePeyGateway } from "./live";
import { MockPeyGateway } from "./mock";

export interface PeyErrorInfo {
  message: string;
  type?: string | undefined;
  requestId?: string | undefined;
}

/**
 * Outcome of a provider call:
 * - ok: 2xx with a valid body.
 * - rejected: definitive 4xx (nothing was created at the provider).
 * - ambiguous: timeout / network / 5xx / unparseable; the provider may have processed it.
 */
export type GatewayResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "rejected"; status: number; peyError: PeyErrorInfo | null }
  | { kind: "ambiguous"; reason: string };

export interface PeyGateway {
  createQr(req: PeyCreateQrRequest): Promise<GatewayResult<PeyCreateQrResponse>>;
  createPushNotification(req: PeyCreatePnRequest): Promise<GatewayResult<PeyCreatePnResponse>>;
  getTransaction(transactionId: string): Promise<GatewayResult<PeyTransaction>>;
  getQrTransactions(qrId: string): Promise<GatewayResult<PeyQrTransactionsResponse>>;
  getBankAccount(bankAccountId: string): Promise<GatewayResult<PeyBankAccount>>;
}

let override: PeyGateway | null = null;

/** Tests only: replaces the gateway built from env. Pass null to restore. */
export function setGatewayForTests(gateway: PeyGateway | null): void {
  override = gateway;
}

export function getGateway(env: Pick<AppEnv, "PAYMENTS_MODE" | "PEY_BASE_URL" | "PEY_API_KEY">): PeyGateway {
  if (override) return override;
  if (env.PAYMENTS_MODE === "live") return new LivePeyGateway(env.PEY_BASE_URL, env.PEY_API_KEY);
  return new MockPeyGateway();
}

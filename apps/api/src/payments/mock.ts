import type {
  PeyBankAccount,
  PeyCreatePnRequest,
  PeyCreatePnResponse,
  PeyCreateQrRequest,
  PeyCreateQrResponse,
  PeyQrTransactionsResponse,
  PeyTransaction,
} from "@trato/shared";
import type { GatewayResult, PeyGateway } from "./gateway";

export interface MockPeyOptions {
  /** Force every create call to fail: definitive 4xx or ambiguous. */
  failCreate?: "rejected" | "ambiguous";
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomId(prefix: string, length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return prefix + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * Deterministic, stateless mock (Workers keep no memory between requests). Payments never come
 * from here: they enter through POST /api/dev/simulate-payment, which uses the real webhook pipeline.
 */
export class MockPeyGateway implements PeyGateway {
  constructor(private readonly options: MockPeyOptions = {}) {}

  private failure<T>(): GatewayResult<T> | null {
    if (this.options.failCreate === "rejected") {
      return { kind: "rejected", status: 400, peyError: { message: "mock rejected", type: "MOCK_ERROR" } };
    }
    if (this.options.failCreate === "ambiguous") return { kind: "ambiguous", reason: "mock_ambiguous" };
    return null;
  }

  createQr(_req: PeyCreateQrRequest): Promise<GatewayResult<PeyCreateQrResponse>> {
    const failed = this.failure<PeyCreateQrResponse>();
    if (failed) return Promise.resolve(failed);
    const id = randomId("MOCKQR");
    const qrString = JSON.stringify({ TYP: 20, v: "1.0", ic: { IDC: id, SER: "MOCK", ENC: randomId("", 24) } });
    return Promise.resolve({ kind: "ok", data: { id, qrString } });
  }

  createPushNotification(_req: PeyCreatePnRequest): Promise<GatewayResult<PeyCreatePnResponse>> {
    const failed = this.failure<PeyCreatePnResponse>();
    if (failed) return Promise.resolve(failed);
    return Promise.resolve({ kind: "ok", data: { transactionId: randomId("MOCKTX", 20), codiId: randomId("MOCKCODI", 12) } });
  }

  getTransaction(_transactionId: string): Promise<GatewayResult<PeyTransaction>> {
    return Promise.resolve({ kind: "rejected", status: 404, peyError: { message: "mock: transaction not found" } });
  }

  getQrTransactions(_qrId: string): Promise<GatewayResult<PeyQrTransactionsResponse>> {
    return Promise.resolve({ kind: "ok", data: { items: [], nextToken: null } });
  }

  getBankAccount(bankAccountId: string): Promise<GatewayResult<PeyBankAccount>> {
    return Promise.resolve({ kind: "ok", data: { id: bankAccountId, codiStatus: "ACTIVE" } });
  }
}

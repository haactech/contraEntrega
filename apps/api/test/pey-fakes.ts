import type {
  PeyBankAccount,
  PeyCreatePnRequest,
  PeyCreatePnResponse,
  PeyCreateQrRequest,
  PeyCreateQrResponse,
  PeyQrTransactionsResponse,
  PeyTransaction,
} from "@trato/shared";
import type { GatewayResult, PeyGateway } from "../src/payments/gateway";

/** Provider ids must be globally unique across tests (they share one D1). */
let seq = 0;

/** Programmable gateway that records every call. */
export class FakeGateway implements PeyGateway {
  qrCalls: PeyCreateQrRequest[] = [];
  pnCalls: PeyCreatePnRequest[] = [];
  qrLookups: string[] = [];
  txLookups: string[] = [];

  createQrResult: (req: PeyCreateQrRequest) => GatewayResult<PeyCreateQrResponse> = () => {
    const n = ++seq;
    return { kind: "ok", data: { id: `FAKEQR${n}`, qrString: JSON.stringify({ ic: { IDC: `FAKEQR${n}` } }) } };
  };
  createPnResult: (req: PeyCreatePnRequest) => GatewayResult<PeyCreatePnResponse> = () => {
    const n = ++seq;
    return { kind: "ok", data: { transactionId: `FAKETX${n}`, codiId: `FAKECODI${n}` } };
  };
  qrTransactions: (qrId: string) => GatewayResult<PeyQrTransactionsResponse> = () => ({
    kind: "ok",
    data: { items: [], nextToken: null },
  });
  transaction: (id: string) => GatewayResult<PeyTransaction> = () => ({ kind: "rejected", status: 404, peyError: null });
  /** Artificial latency for create calls (to force overlapping requests). */
  createDelayMs = 0;

  async createQr(req: PeyCreateQrRequest) {
    this.qrCalls.push(req);
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    return this.createQrResult(req);
  }
  async createPushNotification(req: PeyCreatePnRequest) {
    this.pnCalls.push(req);
    return this.createPnResult(req);
  }
  async getTransaction(id: string) {
    this.txLookups.push(id);
    return this.transaction(id);
  }
  async getQrTransactions(qrId: string) {
    this.qrLookups.push(qrId);
    return this.qrTransactions(qrId);
  }
  async getBankAccount(id: string): Promise<GatewayResult<PeyBankAccount>> {
    return { kind: "ok", data: { id, codiStatus: "ACTIVE" } };
  }
}

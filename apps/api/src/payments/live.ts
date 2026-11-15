import {
  PeyBankAccountSchema,
  PeyCreatePnResponseSchema,
  PeyCreateQrResponseSchema,
  PeyErrorResponseSchema,
  PeyQrTransactionsResponseSchema,
  PeyTransactionSchema,
  type PeyBankAccount,
  type PeyCreatePnRequest,
  type PeyCreatePnResponse,
  type PeyCreateQrRequest,
  type PeyCreateQrResponse,
  type PeyQrTransactionsResponse,
  type PeyTransaction,
} from "@trato/shared";
import type { ZodType, ZodTypeDef } from "zod";
import { logger } from "../lib/logger";
import type { GatewayResult, PeyErrorInfo, PeyGateway } from "./gateway";

const TIMEOUT_MS = 10_000;
const MAX_QR_PAGES = 5;

/** 4xx are definitive, except request-timeout / rate-limit which the provider may recover from. */
const isDefinitive4xx = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

export class LivePeyGateway implements PeyGateway {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<GatewayResult<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : null,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      logger.warn("pey_request_failed", { method, reason: name === "TimeoutError" ? "timeout" : "network" });
      return { kind: "ambiguous", reason: name === "TimeoutError" ? "timeout" : "network_error" };
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      return { kind: "ambiguous", reason: "body_read_error" };
    }

    if (res.ok) {
      try {
        const parsed = schema.safeParse(JSON.parse(text));
        if (parsed.success) return { kind: "ok", data: parsed.data };
      } catch {
        // fall through
      }
      return { kind: "ambiguous", reason: "unparseable_response" };
    }
    if (isDefinitive4xx(res.status)) {
      let peyError: PeyErrorInfo | null = null;
      try {
        const e = PeyErrorResponseSchema.safeParse(JSON.parse(text));
        if (e.success) {
          peyError = { message: e.data.error.message, type: e.data.error.type, requestId: e.data.error.requestId };
        }
      } catch {
        // body is not JSON: keep null
      }
      logger.warn("pey_request_rejected", { method, status: res.status, type: peyError?.type });
      return { kind: "rejected", status: res.status, peyError };
    }
    logger.warn("pey_request_ambiguous", { method, status: res.status });
    return { kind: "ambiguous", reason: `http_${res.status}` };
  }

  createQr(req: PeyCreateQrRequest): Promise<GatewayResult<PeyCreateQrResponse>> {
    return this.request("POST", "/codi/qr", PeyCreateQrResponseSchema, req);
  }

  createPushNotification(req: PeyCreatePnRequest): Promise<GatewayResult<PeyCreatePnResponse>> {
    return this.request("POST", "/codi/pn", PeyCreatePnResponseSchema, req);
  }

  getTransaction(transactionId: string): Promise<GatewayResult<PeyTransaction>> {
    return this.request("GET", `/transaction/${encodeURIComponent(transactionId)}`, PeyTransactionSchema);
  }

  async getQrTransactions(qrId: string): Promise<GatewayResult<PeyQrTransactionsResponse>> {
    const base = `/transaction/codi/qr/${encodeURIComponent(qrId)}`;
    const items: PeyTransaction[] = [];
    let token: string | null | undefined;
    for (let page = 0; page < MAX_QR_PAGES; page++) {
      const qs = token ? `?nextToken=${encodeURIComponent(token)}` : "";
      const r = await this.request("GET", `${base}${qs}`, PeyQrTransactionsResponseSchema);
      if (r.kind !== "ok") {
        // Partial pages are still useful for reconciliation; only fail when nothing was read.
        return page > 0 ? { kind: "ok", data: { items, nextToken: token ?? null } } : r;
      }
      items.push(...r.data.items);
      token = r.data.nextToken;
      if (!token) break;
    }
    return { kind: "ok", data: { items, nextToken: token ?? null } };
  }

  getBankAccount(bankAccountId: string): Promise<GatewayResult<PeyBankAccount>> {
    return this.request("GET", `/bank-account/${encodeURIComponent(bankAccountId)}`, PeyBankAccountSchema);
  }
}

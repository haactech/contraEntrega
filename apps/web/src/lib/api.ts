import type { z } from "zod";
import {
  API_ROUTES,
  AcceptAgreementResponseSchema,
  DemoSellersResponseSchema,
  ErrorEnvelopeSchema,
  EVIDENCE_LIMITS,
  HealthResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  ConfirmProposalResponseSchema,
  ConversationViewSchema,
  CreateApiKeyResponseSchema,
  ListApiKeysResponseSchema,
  ListConversationsResponseSchema,
  ListAgreementsResponseSchema,
  PaymentRequestResponseSchema,
  PublicAgreementResponseSchema,
  ReviewResponseSchema,
  SellerAgreementViewSchema,
  SessionResponseSchema,
  ShareAgreementResponseSchema,
  SimulatePaymentResponseSchema,
  UploadEvidenceResponseSchema,
  type AcceptAgreementRequest,
  type CreateAgreementInput,
  type CreateApiKeyInput,
  type ConversationView,
  type CreatePaymentRequestInput,
  type CreateSessionRequest,
  type ErrorCode,
  type ReviewRequest,
} from "@trato/shared";

/** Client-side error codes in addition to the server's `ErrorCode`. */
export type ClientErrorCode = ErrorCode | "NETWORK" | "BAD_RESPONSE";

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  constructor(code: ClientErrorCode, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function isApiError(e: unknown, code?: ClientErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RequestOptions<S extends z.ZodTypeAny | null> {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  formData?: FormData;
  headers?: Record<string, string>;
  schema: S;
  signal?: AbortSignal | undefined;
}

export type Conditional<T> = { notModified: true } | { notModified: false; data: T; etag: string | null };

export function createApiClient(fetchImpl?: FetchLike) {
  const doFetch: FetchLike = (input, init) => (fetchImpl ?? globalThis.fetch.bind(globalThis))(input, init);

  async function send(path: string, opts: Omit<RequestOptions<null>, "schema">): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
    const init: RequestInit = {
      method: opts.method ?? "GET",
      credentials: "include",
      headers,
      signal: opts.signal ?? null,
    };
    if (opts.formData) {
      init.body = opts.formData;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    try {
      return await doFetch(path, init);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ApiError("NETWORK", "No hay conexión con el servidor.");
    }
  }

  async function failure(res: Response): Promise<ApiError> {
    let parsed: z.infer<typeof ErrorEnvelopeSchema> | null = null;
    try {
      const r = ErrorEnvelopeSchema.safeParse(await res.json());
      if (r.success) parsed = r.data;
    } catch {
      /* body was not JSON */
    }
    if (parsed) return new ApiError(parsed.error.code, parsed.error.message, res.status);
    const code: ErrorCode = res.status === 401 ? "UNAUTHORIZED" : res.status === 429 ? "RATE_LIMITED" : "INTERNAL";
    return new ApiError(code, `Error ${res.status}`, res.status);
  }

  async function parse<S extends z.ZodTypeAny>(res: Response, schema: S): Promise<z.infer<S>> {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError("BAD_RESPONSE", "Respuesta inesperada del servidor.", res.status);
    }
    const r = schema.safeParse(json);
    if (!r.success) throw new ApiError("BAD_RESPONSE", "Respuesta inesperada del servidor.", res.status);
    return r.data;
  }

  async function call<S extends z.ZodTypeAny>(path: string, opts: RequestOptions<S>): Promise<z.infer<S>> {
    const res = await send(path, opts);
    if (!res.ok) throw await failure(res);
    return parse(res, opts.schema);
  }

  async function callVoid(path: string, opts: Omit<RequestOptions<null>, "schema">): Promise<void> {
    const res = await send(path, opts);
    if (!res.ok) throw await failure(res);
  }

  async function conditionalConversation(
    path: string,
    etag?: string | null,
    signal?: AbortSignal,
  ): Promise<Conditional<ConversationView>> {
    const headers: Record<string, string> = etag ? { "If-None-Match": etag } : {};
    const res = await send(path, { headers, signal });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw await failure(res);
    const data = await parse(res, ConversationViewSchema);
    return { notModified: false, data, etag: res.headers.get("ETag") };
  }

  return {
    health: (signal?: AbortSignal) => call(API_ROUTES.health, { schema: HealthResponseSchema, signal }),
    demoSellers: () => call(API_ROUTES.demoSellers, { schema: DemoSellersResponseSchema }),

    getSession: () => call(API_ROUTES.session, { schema: SessionResponseSchema }),
    login: (body: CreateSessionRequest) =>
      call(API_ROUTES.session, { method: "POST", body, schema: SessionResponseSchema }),
    logout: () => callVoid(API_ROUTES.session, { method: "DELETE" }),

    listAgreements: (signal?: AbortSignal) =>
      call(API_ROUTES.agreements, { schema: ListAgreementsResponseSchema, signal }),
    createAgreement: (body: CreateAgreementInput) =>
      call(API_ROUTES.agreements, { method: "POST", body, schema: SellerAgreementViewSchema }),
    getAgreement: (id: string, signal?: AbortSignal) =>
      call(API_ROUTES.agreement(id), { schema: SellerAgreementViewSchema, signal }),
    shareAgreement: (id: string, regenerate = false) =>
      call(API_ROUTES.agreementShare(id), {
        method: "POST",
        body: regenerate ? { regenerate: true } : {},
        schema: ShareAgreementResponseSchema,
      }),
    uploadEvidence: (id: string, file: Blob, filename: string) => {
      const fd = new FormData();
      fd.append(EVIDENCE_LIMITS.fieldName, file, filename);
      return call(API_ROUTES.agreementEvidence(id), {
        method: "POST",
        formData: fd,
        schema: UploadEvidenceResponseSchema,
      });
    },
    deleteEvidence: (id: string, evidenceId: string) =>
      callVoid(API_ROUTES.agreementEvidenceItem(id, evidenceId), { method: "DELETE" }),
    requestReview: (id: string, note?: string) =>
      call(API_ROUTES.agreementRequestReview(id), {
        method: "POST",
        body: note ? { note } : {},
        schema: SellerAgreementViewSchema,
      }),

    /** Buyer view with ETag support. Pass the previous etag to get `notModified` on 304. */
    getPublicAgreement: async (
      token: string,
      etag?: string | null,
      signal?: AbortSignal,
    ): Promise<Conditional<z.infer<typeof PublicAgreementResponseSchema>>> => {
      const headers: Record<string, string> = etag ? { "If-None-Match": etag } : {};
      const res = await send(API_ROUTES.publicTrato(token), { headers, signal });
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw await failure(res);
      const data = await parse(res, PublicAgreementResponseSchema);
      return { notModified: false, data, etag: res.headers.get("ETag") };
    },
    acceptAgreement: (token: string, body: AcceptAgreementRequest) =>
      call(API_ROUTES.publicAccept(token), { method: "POST", body, schema: AcceptAgreementResponseSchema }),
    createPaymentRequest: (
      token: string,
      milestoneId: string,
      body: CreatePaymentRequestInput,
      idempotencyKey: string,
    ) =>
      call(API_ROUTES.publicPaymentRequests(token, milestoneId), {
        method: "POST",
        body,
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        schema: PaymentRequestResponseSchema,
      }),
    refreshPaymentRequest: (token: string, paymentRequestId: string) =>
      call(API_ROUTES.publicRefreshPaymentRequest(token, paymentRequestId), {
        method: "POST",
        schema: PaymentRequestResponseSchema,
      }),
    submitReview: (token: string, body: ReviewRequest) =>
      call(API_ROUTES.publicReview(token), { method: "POST", body, schema: ReviewResponseSchema }),

    // ---- v0.3 conversations ----
    createConversation: () =>
      call(API_ROUTES.conversations, { method: "POST", body: {}, schema: ConversationViewSchema }),
    listConversations: (signal?: AbortSignal) =>
      call(API_ROUTES.conversations, { schema: ListConversationsResponseSchema, signal }),
    getConversation: (id: string, etag?: string | null, signal?: AbortSignal) =>
      conditionalConversation(API_ROUTES.conversation(id), etag, signal),
    postMessage: (id: string, text: string) =>
      call(API_ROUTES.conversationMessages(id), { method: "POST", body: { text }, schema: ConversationViewSchema }),
    confirmProposal: (id: string, proposalId: string) =>
      call(API_ROUTES.conversationProposalConfirm(id, proposalId), {
        method: "POST",
        body: {},
        schema: ConfirmProposalResponseSchema,
      }),
    getPublicConversation: (token: string, etag?: string | null, signal?: AbortSignal) =>
      conditionalConversation(API_ROUTES.publicConversation(token), etag, signal),
    postPublicMessage: (token: string, text: string) =>
      call(API_ROUTES.publicMessages(token), { method: "POST", body: { text }, schema: ConversationViewSchema }),

    // ---- API keys (MCP) ----
    listApiKeys: (signal?: AbortSignal) => call(API_ROUTES.apiKeys, { schema: ListApiKeysResponseSchema, signal }),
    createApiKey: (body: CreateApiKeyInput) =>
      call(API_ROUTES.apiKeys, { method: "POST", body, schema: CreateApiKeyResponseSchema }),
    revokeApiKey: (id: string) => callVoid(API_ROUTES.apiKey(id), { method: "DELETE" }),

    simulatePayment: (paymentRequestId: string) =>
      call(API_ROUTES.devSimulatePayment, {
        method: "POST",
        body: { paymentRequestId },
        schema: SimulatePaymentResponseSchema,
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
export const api: ApiClient = createApiClient();

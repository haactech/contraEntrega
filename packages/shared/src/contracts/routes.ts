const e = encodeURIComponent;

/** Every internal HTTP route. Use these instead of hand-written strings. */
export const API_ROUTES = {
  health: "/api/health",
  demoSellers: "/api/demo/sellers",
  session: "/api/session",

  agreements: "/api/agreements",
  agreement: (id: string) => `/api/agreements/${e(id)}`,
  agreementShare: (id: string) => `/api/agreements/${e(id)}/share`,
  agreementEvidence: (id: string) => `/api/agreements/${e(id)}/evidence`,
  agreementEvidenceItem: (id: string, evidenceId: string) =>
    `/api/agreements/${e(id)}/evidence/${e(evidenceId)}`,
  agreementRequestReview: (id: string) => `/api/agreements/${e(id)}/request-review`,
  agreementExport: (id: string) => `/api/agreements/${e(id)}/export`,

  publicTrato: (token: string) => `/api/public/tratos/${e(token)}`,
  publicAccept: (token: string) => `/api/public/tratos/${e(token)}/accept`,
  publicPaymentRequests: (token: string, milestoneId: string) =>
    `/api/public/tratos/${e(token)}/milestones/${e(milestoneId)}/payment-requests`,
  publicRefreshPaymentRequest: (token: string, paymentRequestId: string) =>
    `/api/public/tratos/${e(token)}/payment-requests/${e(paymentRequestId)}/refresh`,
  publicReview: (token: string) => `/api/public/tratos/${e(token)}/review`,
  publicExport: (token: string) => `/api/public/tratos/${e(token)}/export`,

  conversations: "/api/conversations",
  conversation: (id: string) => `/api/conversations/${e(id)}`,
  conversationMessages: (id: string) => `/api/conversations/${e(id)}/messages`,
  conversationProposalConfirm: (id: string, proposalId: string) =>
    `/api/conversations/${e(id)}/proposals/${e(proposalId)}/confirm`,
  publicConversation: (token: string) => `/api/public/tratos/${e(token)}/conversation`,
  publicMessages: (token: string) => `/api/public/tratos/${e(token)}/messages`,

  apiKeys: "/api/api-keys",
  /** DELETE revokes the key and answers 204 with no body. */
  apiKey: (id: string) => `/api/api-keys/${e(id)}`,
  mcp: "/mcp",

  evidenceFile: (id: string) => `/api/files/evidence/${e(id)}`,
  webhookPey: "/api/webhooks/pey",
  devSimulatePayment: "/api/dev/simulate-payment",
} as const;

/** Frontend (SPA) routes. */
export const APP_ROUTES = {
  home: "/",
  /**
   * v0.3: "Nuevo trato" opens the chat room flow (creates a conversation, then navigates to
   * `room(id)`). The v0.2 form stays reachable at `newAgreementForm`.
   */
  newAgreement: "/tratos/nuevo",
  newAgreementForm: "/tratos/nuevo/formulario",
  /** Seller's conversation room. The buyer keeps using `buyer(token)`, which hosts the same room. */
  room: (conversationId: string) => `/salas/${e(conversationId)}`,
  agreement: (id: string) => `/tratos/${e(id)}`,
  /** Seller settings: connect agents (MCP api keys). */
  agents: "/ajustes/agentes",
  buyer: (token: string) => `/t/${e(token)}`,
} as const;

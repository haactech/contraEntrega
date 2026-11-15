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

  evidenceFile: (id: string) => `/api/files/evidence/${e(id)}`,
  webhookPey: "/api/webhooks/pey",
  devSimulatePayment: "/api/dev/simulate-payment",
} as const;

/** Frontend (SPA) routes. */
export const APP_ROUTES = {
  home: "/",
  newAgreement: "/tratos/nuevo",
  agreement: (id: string) => `/tratos/${e(id)}`,
  buyer: (token: string) => `/t/${e(token)}`,
} as const;

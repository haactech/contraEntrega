import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  ActorType,
  AgreementStatus,
  EventType,
  MilestoneKind,
  MilestoneStatus,
  PaymentMethod,
  PaymentRequestStatus,
  ReviewDecision,
  WebhookProcessingStatus,
} from "@trato/shared";

/** All timestamps are integer epoch milliseconds. Money is integer cents. */

export const demoBankAccounts = sqliteTable("demo_bank_accounts", {
  id: text("id").primaryKey(),
  alias: text("alias").notNull(),
  peyBankAccountId: text("pey_bank_account_id").notNull().unique(),
  clabeLast4: text("clabe_last4").notNull(),
  codiStatus: text("codi_status", { enum: ["PENDING", "PROCESSING", "ACTIVE", "ERROR"] })
    .notNull()
    .default("PENDING"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  verifiedAt: integer("verified_at"),
});

export const sellers = sqliteTable("sellers", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  trade: text("trade").notNull(),
  demoBankAccountId: text("demo_bank_account_id")
    .notNull()
    .unique()
    .references(() => demoBankAccounts.id),
  createdAt: integer("created_at").notNull(),
});

export const agreements = sqliteTable(
  "agreements",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    buyerName: text("buyer_name").notNull(),
    buyerPhone: text("buyer_phone"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    dueDate: text("due_date"),
    totalCents: integer("total_cents").notNull(),
    /** Sealed when the agreement is shared; null while DRAFT. */
    termsJson: text("terms_json"),
    termsSha256: text("terms_sha256"),
    termsVersion: integer("terms_version").notNull().default(1),
    status: text("status").$type<AgreementStatus>().notNull().default("DRAFT"),
    sharedAt: integer("shared_at"),
    buyerAcceptedAt: integer("buyer_accepted_at"),
    buyerAcceptedName: text("buyer_accepted_name"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Bumped on every visible change (ETag). */
    version: integer("version").notNull().default(0),
    /**
     * Nonce set by the guarded UPDATE of each write batch. Dependent statements in the same
     * batch only apply if it still matches, so a lost optimistic-lock race never leaks side effects.
     */
    writeId: text("write_id"),
  },
  (t) => [index("agreements_seller_updated_idx").on(t.sellerId, t.updatedAt)],
);

export const buyerAccess = sqliteTable("buyer_access", {
  id: text("id").primaryKey(),
  agreementId: text("agreement_id")
    .notNull()
    .references(() => agreements.id),
  tokenHash: text("token_hash").notNull().unique(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  issuedAt: integer("issued_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const milestones = sqliteTable(
  "milestones",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    kind: text("kind").$type<MilestoneKind>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<MilestoneStatus>().notNull(),
    deliveryRound: integer("delivery_round").notNull().default(0),
    approvedAt: integer("approved_at"),
    paidAt: integer("paid_at"),
  },
  (t) => [uniqueIndex("milestones_agreement_kind_uq").on(t.agreementId, t.kind)],
);

export const paymentRequests = sqliteTable(
  "payment_requests",
  {
    id: text("id").primaryKey(),
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => milestones.id),
    method: text("method").$type<PaymentMethod>().notNull(),
    provider: text("provider").notNull().default("PEY"),
    providerQrId: text("provider_qr_id"),
    providerTransactionId: text("provider_transaction_id").unique(),
    providerBankAccountId: text("provider_bank_account_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    numRef: text("num_ref").notNull(),
    qrString: text("qr_string"),
    phoneLast4: text("phone_last4"),
    idempotencyKey: text("idempotency_key"),
    status: text("status").$type<PaymentRequestStatus>().notNull(),
    failureReason: text("failure_reason"),
    lastReconciledAt: integer("last_reconciled_at"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    paidAt: integer("paid_at"),
  },
  (t) => [
    // At most one active request per milestone (invariant 10).
    uniqueIndex("payment_requests_active_milestone_uq")
      .on(t.milestoneId)
      .where(sql`${t.status} IN ('CREATING','AWAITING_PAYMENT','CREATION_UNKNOWN')`),
    index("payment_requests_qr_idx").on(t.providerQrId),
  ],
);

export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => milestones.id),
    deliveryRound: integer("delivery_round").notNull().default(0),
    uploadedBy: text("uploaded_by").notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    submitted: integer("submitted", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("evidence_agreement_idx").on(t.agreementId)],
);

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id")
    .notNull()
    .references(() => milestones.id),
  deliveryRound: integer("delivery_round").notNull(),
  decision: text("decision").$type<ReviewDecision>().notNull(),
  comment: text("comment"),
  buyerName: text("buyer_name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const agreementEvents = sqliteTable(
  "agreement_events",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    seq: integer("seq").notNull(),
    eventType: text("event_type").$type<EventType>().notNull(),
    actorType: text("actor_type").$type<ActorType>().notNull(),
    actorRef: text("actor_ref"),
    payloadJson: text("payload_json").notNull().default("{}"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (t) => [uniqueIndex("agreement_events_agreement_seq_uq").on(t.agreementId, t.seq)],
);

export const webhookReceipts = sqliteTable(
  "webhook_receipts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    webhookId: text("webhook_id").notNull(),
    eventType: text("event_type").notNull(),
    transactionId: text("transaction_id"),
    paymentRequestId: text("payment_request_id"),
    receivedAt: integer("received_at").notNull(),
    processedAt: integer("processed_at"),
    processingStatus: text("processing_status").$type<WebhookProcessingStatus>().notNull(),
    unmatchedReason: text("unmatched_reason"),
    /** Never contains metadata.clabe. */
    payloadRedactedJson: text("payload_redacted_json").notNull().default("{}"),
  },
  (t) => [uniqueIndex("webhook_receipts_provider_webhook_uq").on(t.provider, t.webhookId)],
);

export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});

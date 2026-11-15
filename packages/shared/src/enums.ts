import { z } from "zod";

export const AGREEMENT_STATUSES = [
  "DRAFT",
  "SHARED",
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
  "DISPUTED",
] as const;
export const AgreementStatusSchema = z.enum(AGREEMENT_STATUSES);
export type AgreementStatus = z.infer<typeof AgreementStatusSchema>;

export const MILESTONE_KINDS = ["ADVANCE", "BALANCE"] as const;
export const MilestoneKindSchema = z.enum(MILESTONE_KINDS);
export type MilestoneKind = z.infer<typeof MilestoneKindSchema>;

export const ADVANCE_STATUSES = [
  "PENDING_ACCEPTANCE",
  "ELIGIBLE",
  "AWAITING_PAYMENT",
  "PAID",
] as const;
export const AdvanceStatusSchema = z.enum(ADVANCE_STATUSES);
export type AdvanceStatus = z.infer<typeof AdvanceStatusSchema>;

export const BALANCE_STATUSES = [
  "WAITING_DELIVERY",
  "WAITING_BUYER_REVIEW",
  "READY_TO_CHARGE",
  "AWAITING_PAYMENT",
  "PAID",
  "DISPUTED",
] as const;
export const BalanceStatusSchema = z.enum(BALANCE_STATUSES);
export type BalanceStatus = z.infer<typeof BalanceStatusSchema>;

/** Union of every status a milestone row can hold (the column is shared). */
export const MILESTONE_STATUSES = [
  "PENDING_ACCEPTANCE",
  "ELIGIBLE",
  "WAITING_DELIVERY",
  "WAITING_BUYER_REVIEW",
  "READY_TO_CHARGE",
  "AWAITING_PAYMENT",
  "PAID",
  "DISPUTED",
] as const;
export const MilestoneStatusSchema = z.enum(MILESTONE_STATUSES);
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;

export const PAYMENT_METHODS = ["CODI_QR", "CODI_PN"] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PAYMENT_REQUEST_STATUSES = [
  "CREATING",
  "AWAITING_PAYMENT",
  "PAID",
  "EXPIRED_LOCAL",
  "FAILED",
  "CREATION_UNKNOWN",
  "ABANDONED",
] as const;
export const PaymentRequestStatusSchema = z.enum(PAYMENT_REQUEST_STATUSES);
export type PaymentRequestStatus = z.infer<typeof PaymentRequestStatusSchema>;

/** Statuses covered by the partial unique index (one active request per milestone). */
export const ACTIVE_PAYMENT_REQUEST_STATUSES = [
  "CREATING",
  "AWAITING_PAYMENT",
  "CREATION_UNKNOWN",
] as const satisfies readonly PaymentRequestStatus[];

export const REVIEW_DECISIONS = ["APPROVE", "DISPUTE"] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const EVENT_TYPES = [
  "AGREEMENT_CREATED",
  "AGREEMENT_SHARED",
  "LINK_REGENERATED",
  "TERMS_ACCEPTED",
  "PAYMENT_REQUEST_CREATED",
  "PAYMENT_REQUEST_FAILED",
  "PAYMENT_REQUEST_EXPIRED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_UNMATCHED",
  "DUPLICATE_PAYMENT_DETECTED",
  "EVIDENCE_ADDED",
  "EVIDENCE_REMOVED",
  "REVIEW_REQUESTED",
  "DELIVERY_APPROVED",
  "DELIVERY_DISPUTED",
  "AGREEMENT_COMPLETED",
  /** v0.3: terms revised (DRAFT|SHARED only) before acceptance. Visible to the buyer. */
  "TERMS_REVISED",
  /** Cleaning template: per-task review loop. Visible to the buyer. */
  "TASK_SUBMITTED",
  "TASK_APPROVED",
  "TASK_ADJUSTMENT_REQUESTED",
  "ALL_TASKS_APPROVED",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

/** Event types the buyer must never see (spec §D). */
export const BUYER_HIDDEN_EVENT_TYPES = [
  "PAYMENT_UNMATCHED",
  "EVIDENCE_REMOVED",
] as const satisfies readonly EventType[];

export const ACTOR_TYPES = ["SELLER", "BUYER", "SYSTEM", "PROVIDER"] as const;
export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const WEBHOOK_PROCESSING_STATUSES = [
  "PROCESSED",
  "DUPLICATE",
  "UNMATCHED",
  "PENDING_RETRY",
  "IGNORED",
] as const;
export const WebhookProcessingStatusSchema = z.enum(WEBHOOK_PROCESSING_STATUSES);
export type WebhookProcessingStatus = z.infer<typeof WebhookProcessingStatusSchema>;

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_STATE",
  "TERMS_MISMATCH",
  "PAYMENT_PENDING_RECONCILIATION",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "INTERNAL",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  TERMS_MISMATCH: 409,
  PAYMENT_PENDING_RECONCILIATION: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

export const SELLER_NEXT_ACTIONS = [
  "SHARE",
  "WAIT_ACCEPTANCE",
  "WAIT_ADVANCE",
  "UPLOAD_EVIDENCE",
  "WAIT_REVIEW",
  "RESOLVE_DISPUTE",
  "WAIT_BALANCE",
  "DONE",
] as const;
export const SellerNextActionSchema = z.enum(SELLER_NEXT_ACTIONS);
export type SellerNextAction = z.infer<typeof SellerNextActionSchema>;

export const BUYER_NEXT_ACTIONS = [
  "ACCEPT",
  "PAY_ADVANCE",
  "WAIT_DELIVERY",
  "REVIEW",
  "PAY_BALANCE",
  "WAIT_SELLER",
  "DONE",
] as const;
export const BuyerNextActionSchema = z.enum(BUYER_NEXT_ACTIONS);
export type BuyerNextAction = z.infer<typeof BuyerNextActionSchema>;

export const PAYMENTS_MODES = ["mock", "live"] as const;
export const PaymentsModeSchema = z.enum(PAYMENTS_MODES);
export type PaymentsMode = z.infer<typeof PaymentsModeSchema>;

/* ---------------------------------------------------- v0.3 conversational */

export const CONVERSATION_AUTHOR_TYPES = ["SELLER", "BUYER", "ASSISTANT"] as const;
export const ConversationAuthorTypeSchema = z.enum(CONVERSATION_AUTHOR_TYPES);
export type ConversationAuthorType = z.infer<typeof ConversationAuthorTypeSchema>;

export const MESSAGE_KINDS = ["TEXT", "PROPOSAL"] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const PROPOSAL_STATUSES = ["OPEN", "SELLER_CONFIRMED", "ACCEPTED", "SUPERSEDED"] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ASSISTANT_INTENTS = [
  "PROPOSE_TERMS",
  "REVISE_TERMS",
  "ASK_CLARIFICATION",
  "SUGGEST_ACTION",
  "ANSWER",
  "NONE",
] as const;
export const AssistantIntentSchema = z.enum(ASSISTANT_INTENTS);
export type AssistantIntent = z.infer<typeof AssistantIntentSchema>;

export const PROPOSAL_FIELDS = [
  "title",
  "total",
  "advance",
  "acceptanceCriteria",
  "buyerName",
  "dueDate",
  "tasks",
] as const;
export const ProposalFieldSchema = z.enum(PROPOSAL_FIELDS);
export type ProposalField = z.infer<typeof ProposalFieldSchema>;

/** Channel through which a human action reached the server (stored in event payloads). */
export const ACTION_VIAS = ["web", "chat", "mcp"] as const;
export const ActionViaSchema = z.enum(ACTION_VIAS);
export type ActionVia = z.infer<typeof ActionViaSchema>;

/* ------------------------------------------------------- cleaning template */

export const SERVICE_TYPES = ["GENERIC", "CLEANING"] as const;
export const ServiceTypeSchema = z.enum(SERVICE_TYPES);
export type ServiceType = z.infer<typeof ServiceTypeSchema>;

export const PAYMENT_STRATEGIES = ["ADVANCE_AND_BALANCE", "ON_COMPLETION"] as const;
export const PaymentStrategySchema = z.enum(PAYMENT_STRATEGIES);
export type PaymentStrategy = z.infer<typeof PaymentStrategySchema>;

export const TASK_STATUSES = ["TODO", "IN_REVIEW", "NEEDS_ADJUSTMENT", "APPROVED"] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_REVIEW_DECISIONS = ["APPROVE", "REQUEST_ADJUSTMENT"] as const;
export const TaskReviewDecisionSchema = z.enum(TASK_REVIEW_DECISIONS);
export type TaskReviewDecision = z.infer<typeof TaskReviewDecisionSchema>;

export const EVIDENCE_KINDS = ["BEFORE", "AFTER"] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

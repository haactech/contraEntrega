import { z } from "zod";
import {
  ActorTypeSchema,
  AgreementStatusSchema,
  BuyerNextActionSchema,
  EventTypeSchema,
  EvidenceKindSchema,
  PaymentStrategySchema,
  ServiceTypeSchema,
  TaskReviewDecisionSchema,
  TaskStatusSchema,
  MilestoneKindSchema,
  MilestoneStatusSchema,
  PaymentMethodSchema,
  PaymentRequestStatusSchema,
  ReviewDecisionSchema,
  SellerNextActionSchema,
} from "../enums";
import {
  AccountSummarySchema,
  CentsSchema,
  DateOnlySchema,
  IsoDateTimeSchema,
  Last4Schema,
  Sha256HexSchema,
} from "./common";

export const NextActionSchema = z.union([SellerNextActionSchema, BuyerNextActionSchema]);
export type NextAction = z.infer<typeof NextActionSchema>;

export const SellerSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  trade: z.string(),
  account: AccountSummarySchema,
});
export type SellerSummary = z.infer<typeof SellerSummarySchema>;

export const TaskProgressSchema = z.object({
  approved: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

export const AgreementSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  buyerName: z.string(),
  totalCents: CentsSchema,
  status: AgreementStatusSchema,
  dueDate: DateOnlySchema.nullable(),
  /** Room of this agreement (every agreement has one; created lazily for pre-v0.3 data). */
  conversationId: z.string().nullable(),
  nextAction: SellerNextActionSchema,
  serviceType: ServiceTypeSchema,
  taskProgress: TaskProgressSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AgreementSummary = z.infer<typeof AgreementSummarySchema>;

export const MilestoneViewSchema = z.object({
  id: z.string(),
  kind: MilestoneKindSchema,
  amountCents: CentsSchema,
  description: z.string(),
  status: MilestoneStatusSchema,
  deliveryRound: z.number().int().nonnegative(),
  approvedAt: IsoDateTimeSchema.nullable(),
  paidAt: IsoDateTimeSchema.nullable(),
});
export type MilestoneView = z.infer<typeof MilestoneViewSchema>;

export const PaymentRequestViewSchema = z.object({
  id: z.string(),
  milestoneId: z.string(),
  milestoneKind: MilestoneKindSchema,
  method: PaymentMethodSchema,
  status: PaymentRequestStatusSchema,
  amountCents: CentsSchema,
  numRef: z.string(),
  qrString: z.string().nullable(),
  phoneLast4: Last4Schema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
});
export type PaymentRequestView = z.infer<typeof PaymentRequestViewSchema>;

export const EvidenceViewSchema = z.object({
  id: z.string(),
  milestoneId: z.string(),
  deliveryRound: z.number().int().nonnegative(),
  /** Signed, short-lived URL served by the Worker from R2. */
  url: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256HexSchema,
  submitted: z.boolean(),
  /** Cleaning: the task this photo belongs to (null for generic evidence). */
  taskId: z.string().nullable(),
  kind: EvidenceKindSchema,
  /** Cleaning: task revision the photo was uploaded for (null for generic evidence). */
  revisionNumber: z.number().int().positive().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;

export const TaskReviewViewSchema = z.object({
  id: z.string(),
  revisionNumber: z.number().int().positive(),
  decision: TaskReviewDecisionSchema,
  comment: z.string().nullable(),
  reviewerName: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type TaskReviewView = z.infer<typeof TaskReviewViewSchema>;

export const TaskViewSchema = z.object({
  id: z.string(),
  position: z.number().int().nonnegative(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  revision: z.number().int().positive(),
  submittedAt: IsoDateTimeSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  evidence: z.array(EvidenceViewSchema),
  reviews: z.array(TaskReviewViewSchema),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const EventViewSchema = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  type: EventTypeSchema,
  actorType: ActorTypeSchema,
  occurredAt: IsoDateTimeSchema,
  payload: z.record(z.unknown()),
});
export type EventView = z.infer<typeof EventViewSchema>;

export const ReviewViewSchema = z.object({
  id: z.string(),
  milestoneId: z.string(),
  deliveryRound: z.number().int().nonnegative(),
  decision: ReviewDecisionSchema,
  comment: z.string().nullable(),
  buyerName: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type ReviewView = z.infer<typeof ReviewViewSchema>;

const AgreementCoreShape = {
  id: z.string(),
  code: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  buyerName: z.string(),
  /** Always masked, e.g. "******5678". */
  buyerPhoneMasked: z.string().nullable(),
  dueDate: DateOnlySchema.nullable(),
  totalCents: CentsSchema,
  status: AgreementStatusSchema,
  termsSha256: Sha256HexSchema,
  termsVersion: z.number().int().positive(),
  sharedAt: IsoDateTimeSchema.nullable(),
  buyerAcceptedAt: IsoDateTimeSchema.nullable(),
  buyerAcceptedName: z.string().nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  version: z.number().int().nonnegative(),
};

export const AgreementCoreSchema = z.object(AgreementCoreShape);
export type AgreementCore = z.infer<typeof AgreementCoreSchema>;

export const SellerAgreementViewSchema = z.object({
  agreement: AgreementCoreSchema,
  account: AccountSummarySchema,
  milestones: z.array(MilestoneViewSchema),
  paymentRequests: z.array(PaymentRequestViewSchema),
  evidence: z.array(EvidenceViewSchema),
  serviceType: ServiceTypeSchema,
  paymentStrategy: PaymentStrategySchema,
  /** Cleaning checklist; null for generic agreements. */
  tasks: z.array(TaskViewSchema).nullable(),
  taskProgress: TaskProgressSchema.nullable(),
  reviews: z.array(ReviewViewSchema),
  events: z.array(EventViewSchema),
  shareUrl: z.string().nullable(),
  whatsappUrl: z.string().nullable(),
  /** Room of this agreement; null only for rows that have not been backfilled yet. */
  conversationId: z.string().nullable(),
  nextAction: SellerNextActionSchema,
});
export type SellerAgreementView = z.infer<typeof SellerAgreementViewSchema>;

export const BuyerAgreementViewSchema = z.object({
  agreement: AgreementCoreSchema,
  seller: z.object({ displayName: z.string(), trade: z.string() }),
  payee: AccountSummarySchema,
  milestones: z.array(MilestoneViewSchema),
  paymentRequests: z.array(PaymentRequestViewSchema),
  evidence: z.array(EvidenceViewSchema),
  serviceType: ServiceTypeSchema,
  paymentStrategy: PaymentStrategySchema,
  /** Cleaning checklist; null for generic agreements. */
  tasks: z.array(TaskViewSchema).nullable(),
  taskProgress: TaskProgressSchema.nullable(),
  reviews: z.array(ReviewViewSchema),
  events: z.array(EventViewSchema),
  activePaymentRequest: PaymentRequestViewSchema.nullable(),
  nextAction: BuyerNextActionSchema,
});
export type BuyerAgreementView = z.infer<typeof BuyerAgreementViewSchema>;

import { z } from "zod";
import { AllowedActionSchema } from "../actions";
import {
  ActorTypeSchema,
  ConversationAuthorTypeSchema,
  EventTypeSchema,
  MessageKindSchema,
  ProposalStatusSchema,
  AgreementStatusSchema,
  SellerNextActionSchema,
} from "../enums";
import { CentsSchema, DateOnlySchema, IsoDateTimeSchema, Sha256HexSchema } from "./common";
import { BuyerAgreementViewSchema, SellerAgreementViewSchema } from "./views";

/** Terms of a proposal as shown to both parties (no buyer phone). */
export const ProposalTermsSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  buyerName: z.string(),
  dueDate: DateOnlySchema.nullable(),
  totalCents: CentsSchema,
  advanceCents: CentsSchema,
  /** totalCents - advanceCents, computed by the server. */
  balanceCents: CentsSchema,
});
export type ProposalTerms = z.infer<typeof ProposalTermsSchema>;

export const ProposalViewSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  status: ProposalStatusSchema,
  terms: ProposalTermsSchema,
  /** Hash of the canonical terms; the buyer accepts exactly this. */
  termsSha256: Sha256HexSchema,
  createdAt: IsoDateTimeSchema,
  confirmedAt: IsoDateTimeSchema.nullable(),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

export const AssistantInfoSchema = z.object({ provider: z.string(), model: z.string() });
export type AssistantInfo = z.infer<typeof AssistantInfoSchema>;

/** Assistant availability (no secrets). */
export const AssistantStatusSchema = z.object({
  enabled: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
});
export type AssistantStatus = z.infer<typeof AssistantStatusSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  agreementId: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  version: z.number().int().nonnegative(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationSummarySchema = z.object({
  id: z.string(),
  agreementId: z.string().nullable(),
  agreementCode: z.string().nullable(),
  /** Agreement title, else the open proposal's title, else null (empty room). */
  title: z.string().nullable(),
  buyerName: z.string().nullable(),
  totalCents: CentsSchema.nullable(),
  agreementStatus: AgreementStatusSchema.nullable(),
  nextAction: SellerNextActionSchema.nullable(),
  hasOpenProposal: z.boolean(),
  lastMessagePreview: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ListConversationsResponseSchema = z.object({ conversations: z.array(ConversationSummarySchema) });
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;

const FeedBase = {
  id: z.string(),
  /** Per-source sequence (messages.seq or agreement_events.seq); order with `compareFeedItems`. */
  seq: z.number().int().positive(),
  occurredAt: IsoDateTimeSchema,
};

export const FeedMessageSchema = z.object({
  type: z.literal("message"),
  ...FeedBase,
  authorType: ConversationAuthorTypeSchema,
  authorName: z.string(),
  kind: MessageKindSchema,
  text: z.string(),
  /** Embedded when kind = PROPOSAL. */
  proposal: ProposalViewSchema.nullable(),
  /** Deterministic server notice (e.g. «No pude procesar tu mensaje…»): authorType stays ASSISTANT, `assistant` is null. */
  system: z.boolean(),
  /** Set only for AI ASSISTANT messages (null for `system` ones). */
  assistant: AssistantInfoSchema.nullable(),
});
export type FeedMessage = z.infer<typeof FeedMessageSchema>;

export const FeedEventSchema = z.object({
  type: z.literal("event"),
  ...FeedBase,
  eventType: EventTypeSchema,
  actorType: ActorTypeSchema,
  payload: z.record(z.unknown()),
});
export type FeedEvent = z.infer<typeof FeedEventSchema>;

export const FeedItemSchema = z.discriminatedUnion("type", [FeedMessageSchema, FeedEventSchema]);
export type FeedItem = z.infer<typeof FeedItemSchema>;

/** Feed order: occurredAt, then messages before events at the same instant, then seq. */
export function compareFeedItems(a: FeedItem, b: FeedItem): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.type !== b.type) return a.type === "message" ? -1 : 1;
  return a.seq - b.seq;
}

export const ConversationViewSchema = z.object({
  /** Who is looking: drives which `agreement` shape is present. */
  role: z.enum(["SELLER", "BUYER"]),
  conversation: ConversationSchema,
  feed: z.array(FeedItemSchema),
  /** Latest proposal in status OPEN or SELLER_CONFIRMED (not yet superseded), if any. */
  activeProposal: ProposalViewSchema.nullable(),
  agreement: z.union([SellerAgreementViewSchema, BuyerAgreementViewSchema]).nullable(),
  /** Deterministic chips for this viewer (`allowedActions(state, role)`). */
  allowedActions: z.array(AllowedActionSchema),
  /** True while the assistant is processing a message (UI shows "escribiendo"). */
  assistantBusy: z.boolean(),
  assistant: AssistantStatusSchema,
});
export type ConversationView = z.infer<typeof ConversationViewSchema>;

export const CreateConversationResponseSchema = ConversationViewSchema;
export type CreateConversationResponse = ConversationView;

export const POST_MESSAGE_MAX_CHARS = 2000;
export const PostMessageInputSchema = z.object({
  text: z.string().trim().min(1, "Escribe un mensaje.").max(POST_MESSAGE_MAX_CHARS, "El mensaje es demasiado largo."),
});
export type PostMessageInput = z.infer<typeof PostMessageInputSchema>;
export const PostMessageResponseSchema = ConversationViewSchema;
export type PostMessageResponse = ConversationView;

export const ConfirmProposalResponseSchema = z.object({
  conversation: ConversationViewSchema,
  shareUrl: z.string(),
  whatsappUrl: z.string(),
});
export type ConfirmProposalResponse = z.infer<typeof ConfirmProposalResponseSchema>;

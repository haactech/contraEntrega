import { z } from "zod";
import { ALLOWED_ACTIONS, PROPOSAL_FIELDS, ASSISTANT_INTENTS } from "@trato/shared";

/** Dataset format (one JSON object per line of `evals/datasets/<suite>.jsonl`). */

export const SUITES = ["extraction", "clarification", "revision", "actions", "safety"] as const;
export type Suite = (typeof SUITES)[number];

export const SCENARIOS = [
  /** Conversation without agreement; `terms` (optional) is an OPEN proposal. */
  "NO_AGREEMENT",
  "OPEN_PROPOSAL",
  "SHARED",
  "ACCEPTED",
  "ADVANCE_PAYMENT_PENDING",
  "IN_PROGRESS",
  "EVIDENCE_READY",
  "IN_REVIEW",
  "READY_TO_CHARGE",
  "DISPUTED",
  "DISPUTED_FIXED",
  "COMPLETED",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const TermsSchema = z.object({
  title: z.string(),
  description: z.string().default(""),
  acceptanceCriteria: z.string(),
  buyerName: z.string(),
  dueDate: z.string().nullable().default(null),
  totalMxn: z.number(),
  advanceMxn: z.number(),
});
export type EvalTerms = z.infer<typeof TermsSchema>;

export const EvalMessageSchema = z.object({
  author: z.enum(["SELLER", "BUYER", "ASSISTANT", "SYSTEM"]),
  text: z.string(),
});

const Keywords = z.object({
  keywords: z.array(z.string()).min(1),
  /** At least this many of `keywords` must appear (accent/case-insensitive). Default 1. */
  min: z.number().int().min(1).default(1),
});

/** All fields optional: a grader only checks what the case states. */
const ExpectBase = z.object({
  /** Allowed intents (user-visible turn). */
  intent: z.array(z.enum(ASSISTANT_INTENTS)).min(1).optional(),
  /** true: no proposal; false: proposal required. Default: derived from `intent`. */
  proposal: z.boolean().optional(),
  /** Amounts in cents, checked after `normalizeProposal`. */
  totalCents: z.number().int().optional(),
  advanceCents: z.number().int().optional(),
  /** Exact date, or null = must not invent a date. */
  dueDate: z.string().nullable().optional(),
  /** Case/accents-insensitive containment; null = must be null. */
  buyerName: z.string().nullable().optional(),
  titleKeywords: Keywords.optional(),
  criteriaKeywords: Keywords.optional(),
  /** missingFields must include all of these. */
  missingFields: z.array(z.enum(PROPOSAL_FIELDS)).optional(),
  /** suggestedAction must be one of these (null = no action). Always checked against `allowed` too. */
  action: z.array(z.enum(ALLOWED_ACTIONS).nullable()).optional(),
  /** Regex sources (matched against the accent-stripped lowercase reply) that must NOT appear. */
  forbidden: z.array(z.string()).optional(),
  /** The reply must contain at least `min` of these words/phrases. */
  replyKeywords: Keywords.optional(),
  /** Revision: every term not mentioned in this expect must equal the base terms. */
  keepRest: z.boolean().optional(),
  /** When the model may legitimately ask instead of proposing, skip proposal-only checks. */
  proposalOptional: z.boolean().optional(),
});

export const ExpectSchema = ExpectBase.extend({
  /** Pass if ANY alternative passes (each is a full expect without `anyOf`). */
  anyOf: z.array(ExpectBase).min(2).optional(),
});
export type Expect = z.infer<typeof ExpectSchema>;
export type ExpectBody = z.infer<typeof ExpectBase>;

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z]+-\d{3}$/),
  suite: z.enum(SUITES),
  description: z.string().min(5),
  input: z.object({
    /** YYYY-MM-DD in America/Mexico_City; fixed so relative dates are reproducible. */
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    speaker: z.enum(["SELLER", "BUYER"]),
    scenario: z.enum(SCENARIOS),
    /** Preset name (see `scenarios.ts`) or inline terms; required for every scenario but NO_AGREEMENT. */
    terms: z.union([z.string(), TermsSchema]).optional(),
    /** Chronological; the last message is the one to answer. */
    messages: z.array(EvalMessageSchema).min(1),
  }),
  expect: ExpectSchema,
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

/* ---------------------------------------------------------------- results */

export interface CaseRun {
  id: string;
  suite: Suite;
  run: number;
  pass: boolean;
  reasons: string[];
  /** Cases that state amounts: were both exact? null when the case does not check amounts. */
  amountsOk: boolean | null;
  ok: boolean;
  kind: string | null;
  message: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  repairs: number;
  /** Raw model output before sanitizing. */
  raw: unknown;
  /** What the user sees. */
  sanitized: unknown;
  flags: string[];
}

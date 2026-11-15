import { z } from "zod";
import { AllowedActionSchema } from "../actions";
import { MilestoneKindSchema, PaymentMethodSchema, ReviewDecisionSchema, AgreementStatusSchema } from "../enums";
import { mxnToCents } from "../money";
import { DateOnlySchema, PhoneSchema, Sha256HexSchema } from "./common";
import { EVIDENCE_LIMITS, type CreateAgreementInput } from "./agreements";
import {
  AgreementSummarySchema,
  BuyerAgreementViewSchema,
  EvidenceViewSchema,
  PaymentRequestViewSchema,
  SellerAgreementViewSchema,
} from "./views";

/**
 * MCP tool catalogue (spec v0.3 §6). The server registers `MCP_TOOLS` in a loop and calls the same
 * services as the HTTP API. There is intentionally NO tool that marks anything PAID or changes
 * amounts or bank accounts. Every output carries `allowedActions`.
 */

const AllowedActionsField = z
  .array(AllowedActionSchema)
  .describe("Acciones que la persona (o tú en su nombre) puede ejecutar ahora; no intentes otras.");

/** Base64 of a 5 MB image is ceil(5 MiB / 3) * 4 characters. */
export const MCP_EVIDENCE_MAX_BASE64_CHARS = Math.ceil(EVIDENCE_LIMITS.maxBytes / 3) * 4;

const AgreementId = z.string().min(1).max(64).describe("Id del trato (campo agreement.id).");
const BuyerToken = z
  .string()
  .min(8)
  .max(200)
  .describe("Token del enlace del trato que recibió el comprador (la parte final de /t/<token>).");

/* ---------------------------------------------------------------- seller */

export const ListAgreementsMcpInputSchema = z.object({
  status: AgreementStatusSchema.optional().describe("Filtra por estado."),
  limit: z.number().int().min(1).max(100).optional().describe("Máximo de tratos (por omisión 50)."),
});
export const ListAgreementsMcpOutputSchema = z.object({
  agreements: z.array(AgreementSummarySchema.extend({ allowedActions: AllowedActionsField })),
  /** Always [] for this tool: actions are listed per agreement. */
  allowedActions: AllowedActionsField,
});

export const GetAgreementMcpInputSchema = z.object({ agreementId: AgreementId });
export const SellerAgreementMcpOutputSchema = SellerAgreementViewSchema.extend({ allowedActions: AllowedActionsField });

/** Agent-friendly terms: pesos, not cents (the server converts with `mcpTermsToCreateInput`). */
export const CreateAgreementMcpInputSchema = z.object({
  title: z.string().trim().min(3).max(120).describe("Título corto, ej. «Puerta de herrería»."),
  description: z.string().trim().max(2000).optional().describe("Descripción del trabajo."),
  acceptanceCriteria: z
    .string()
    .trim()
    .min(3)
    .max(1000)
    .describe("Criterios verificables para dar por entregado el trabajo."),
  buyerName: z.string().trim().min(2).max(80).describe("Nombre del comprador."),
  buyerPhone: PhoneSchema.optional().describe("Teléfono de 10 dígitos (opcional)."),
  dueDate: DateOnlySchema.optional().describe("Fecha de entrega AAAA-MM-DD (opcional)."),
  totalMxn: z.number().positive().max(2_000_000).describe("Total en pesos mexicanos (hasta 2 decimales)."),
  advanceMxn: z
    .number()
    .positive()
    .max(1_000_000)
    .describe("Anticipo en pesos mexicanos; debe ser menor al total."),
});
export type CreateAgreementMcpInput = z.infer<typeof CreateAgreementMcpInputSchema>;

/** Converts MCP terms (pesos) into the canonical `CreateAgreementInput` (cents). */
export function mcpTermsToCreateInput(input: CreateAgreementMcpInput): CreateAgreementInput {
  return {
    title: input.title,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria,
    buyerName: input.buyerName,
    ...(input.buyerPhone ? { buyerPhone: input.buyerPhone } : {}),
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    totalCents: mxnToCents(input.totalMxn),
    advanceCents: mxnToCents(input.advanceMxn),
  };
}

export const ShareAgreementMcpInputSchema = z.object({
  agreementId: AgreementId,
  regenerate: z.boolean().optional().describe("true invalida el enlace anterior y crea uno nuevo."),
});
export const ShareAgreementMcpOutputSchema = SellerAgreementMcpOutputSchema.extend({
  shareUrl: z.string(),
  whatsappUrl: z.string(),
});

export const EVIDENCE_MEDIA_TYPES = EVIDENCE_LIMITS.allowedMimeTypes;
export const AddEvidenceMcpInputSchema = z.object({
  agreementId: AgreementId,
  imageBase64: z
    .string()
    .min(1)
    .max(MCP_EVIDENCE_MAX_BASE64_CHARS, "La imagen supera 5 MB.")
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Base64 inválido: envía solo los datos, sin prefijo data:.")
    .describe("Contenido de la imagen en base64 (sin prefijo data:). Máximo 5 MB."),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]).describe("Tipo MIME de la imagen."),
  note: z.string().trim().max(500).optional().describe("Nota opcional sobre la foto."),
});
export const AddEvidenceMcpOutputSchema = z.object({
  evidence: EvidenceViewSchema,
  unsubmittedCount: z.number().int().nonnegative().describe("Fotos subidas en esta ronda aún sin enviar a revisión."),
  allowedActions: AllowedActionsField,
});

export const RequestReviewMcpInputSchema = z.object({
  agreementId: AgreementId,
  note: z.string().trim().max(500).optional().describe("Mensaje opcional para el comprador."),
});

export const ExportAgreementMcpInputSchema = z.object({ agreementId: AgreementId });
export const ExportAgreementMcpOutputSchema = z.object({
  filename: z.string(),
  mimeType: z.literal("text/html"),
  html: z.string().describe("Comprobante imprimible en HTML (incluye conversación, evidencias y pagos)."),
  allowedActions: AllowedActionsField,
});

/* ----------------------------------------------------------------- buyer */

export const BuyerGetAgreementMcpInputSchema = z.object({ buyerToken: BuyerToken });
export const BuyerAgreementMcpOutputSchema = BuyerAgreementViewSchema.extend({ allowedActions: AllowedActionsField });

export const BuyerAcceptMcpInputSchema = z.object({
  buyerToken: BuyerToken,
  buyerName: z.string().trim().min(2).max(80).describe("Nombre completo de quien acepta."),
  termsSha256: Sha256HexSchema.describe("Hash de los términos vigentes (agreement.termsSha256) que se están aceptando."),
  consent: z.literal(true).describe("Debe ser true: confirma que la persona aceptó las condiciones."),
});

export const BuyerReviewMcpInputSchema = z.object({
  buyerToken: BuyerToken,
  decision: ReviewDecisionSchema.describe("APPROVE: recibido y conforme. DISPUTE: reportar un problema."),
  comment: z.string().trim().max(1000).optional().describe("Obligatorio (mín. 5 caracteres) si decision = DISPUTE."),
  buyerName: z.string().trim().min(2).max(80),
});

export const BuyerCreatePaymentRequestMcpInputSchema = z.object({
  buyerToken: BuyerToken,
  milestoneKind: MilestoneKindSchema.describe("ADVANCE (anticipo) o BALANCE (saldo)."),
  method: PaymentMethodSchema.describe("CODI_QR genera un QR; CODI_PN envía una solicitud push al banco del comprador."),
  phoneNumber: PhoneSchema.optional().describe("Teléfono de 10 dígitos; obligatorio con CODI_PN."),
});
export const PaymentRequestMcpOutputSchema = z.object({
  paymentRequest: PaymentRequestViewSchema,
  allowedActions: AllowedActionsField,
});

export const BuyerRefreshPaymentMcpInputSchema = z.object({
  buyerToken: BuyerToken,
  paymentRequestId: z.string().min(1).max(64),
});

/* -------------------------------------------------------------- registry */

export type McpAudience = "seller" | "buyer";

export interface McpTool {
  name: string;
  audience: McpAudience;
  /** Spanish, written for agents: what it does, preconditions, what it cannot do. */
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  /** MCP annotation: true when the tool never changes state. */
  readOnly: boolean;
}

const COMMON_LIMITS =
  "Nunca marca pagos como realizados ni cambia importes o cuentas: el dinero solo lo confirma el proveedor de pagos.";

export const MCP_TOOLS = [
  {
    name: "list_agreements",
    audience: "seller",
    readOnly: true,
    description:
      "Lista los tratos del prestador dueño de la llave, del más reciente al más antiguo, con su estado y las acciones permitidas de cada uno. Solo lectura. No incluye detalle de hitos ni evidencias; usa get_agreement para eso.",
    inputSchema: ListAgreementsMcpInputSchema,
    outputSchema: ListAgreementsMcpOutputSchema,
  },
  {
    name: "get_agreement",
    audience: "seller",
    readOnly: true,
    description:
      "Devuelve el detalle completo de un trato del prestador: términos, hitos, solicitudes de pago, evidencias, revisiones, eventos y allowedActions. Solo lectura. Falla con NOT_FOUND si el trato no es del prestador.",
    inputSchema: GetAgreementMcpInputSchema,
    outputSchema: SellerAgreementMcpOutputSchema,
  },
  {
    name: "create_agreement",
    audience: "seller",
    readOnly: false,
    description:
      "Crea un trato en borrador con términos estructurados (montos en pesos MXN; el anticipo debe ser menor al total). Precondición: el prestador ya acordó estos términos con el comprador. Queda en DRAFT: no lo comparte; llama después a share_agreement. No acepta por el comprador ni cobra nada. " +
      COMMON_LIMITS,
    inputSchema: CreateAgreementMcpInputSchema,
    outputSchema: SellerAgreementMcpOutputSchema,
  },
  {
    name: "share_agreement",
    audience: "seller",
    readOnly: false,
    description:
      "Genera el enlace para el comprador y deja el trato en SHARED (listo para que el comprador lo acepte). Devuelve shareUrl y whatsappUrl; entrégaselos al prestador, no los publiques. Con regenerate=true el enlace anterior deja de funcionar. No funciona si el trato ya está completado.",
    inputSchema: ShareAgreementMcpInputSchema,
    outputSchema: ShareAgreementMcpOutputSchema,
  },
  {
    name: "add_evidence",
    audience: "seller",
    readOnly: false,
    description:
      "Adjunta una foto de la entrega como evidencia (se guarda con su SHA-256). Precondición: el anticipo ya está pagado y el trato espera entrega o está en disputa (allowedActions incluye UPLOAD_EVIDENCE). Máximo 3 fotos por entrega, 5 MB cada una, JPEG/PNG/WebP, enviada en base64; no se aceptan URLs remotas. No envía la entrega a revisión: usa request_review.",
    inputSchema: AddEvidenceMcpInputSchema,
    outputSchema: AddEvidenceMcpOutputSchema,
  },
  {
    name: "request_review",
    audience: "seller",
    readOnly: false,
    description:
      "Marca la entrega como terminada y la envía a revisión del comprador (o re-entrega tras una disputa). Precondición: hay al menos una foto sin enviar (allowedActions incluye REQUEST_REVIEW o REDELIVER). No aprueba la entrega ni cobra: solo el comprador puede aprobar.",
    inputSchema: RequestReviewMcpInputSchema,
    outputSchema: SellerAgreementMcpOutputSchema,
  },
  {
    name: "export_agreement",
    audience: "seller",
    readOnly: true,
    description:
      "Devuelve el comprobante imprimible del trato en HTML (conversación, versiones de propuesta, evidencias, revisiones y pagos). Solo lectura.",
    inputSchema: ExportAgreementMcpInputSchema,
    outputSchema: ExportAgreementMcpOutputSchema,
  },
  {
    name: "buyer_get_agreement",
    audience: "buyer",
    readOnly: true,
    description:
      "Para el comprador: devuelve el trato visible con su enlace (términos, hitos, pagos, evidencias, estado) y allowedActions. Solo lectura. Requiere el buyerToken del enlace; si el token pertenece a un trato del mismo prestador dueño de la llave, responde 403.",
    inputSchema: BuyerGetAgreementMcpInputSchema,
    outputSchema: BuyerAgreementMcpOutputSchema,
  },
  {
    name: "buyer_accept",
    audience: "buyer",
    readOnly: false,
    description:
      "Para el comprador: acepta los términos del trato. Exige termsSha256 (el hash vigente, de buyer_get_agreement) y consent=true; si los términos cambiaron, falla con TERMS_MISMATCH. Aceptar NO es pagar. Solo ejecútalo si la persona lo pidió expresamente.",
    inputSchema: BuyerAcceptMcpInputSchema,
    outputSchema: BuyerAgreementMcpOutputSchema,
  },
  {
    name: "buyer_review",
    audience: "buyer",
    readOnly: false,
    description:
      "Para el comprador: revisa la entrega. APPROVE confirma que lo recibió conforme y habilita el cobro del saldo (no lo paga); DISPUTE reporta un problema y exige un comentario. Precondición: la entrega está en revisión (allowedActions incluye APPROVE_DELIVERY). La decisión debe ser de la persona; no la tomes por tu cuenta.",
    inputSchema: BuyerReviewMcpInputSchema,
    outputSchema: BuyerAgreementMcpOutputSchema,
  },
  {
    name: "buyer_create_payment_request",
    audience: "buyer",
    readOnly: false,
    description:
      "Para el comprador: crea la solicitud de pago CoDi del anticipo o del saldo, por QR o con push al banco (requiere teléfono). Precondición: allowedActions incluye PAY_ADVANCE o PAY_BALANCE. Solo genera la solicitud; la persona debe autorizar el pago en su app bancaria y solo el evento verificado del proveedor lo marca como pagado. " +
      COMMON_LIMITS,
    inputSchema: BuyerCreatePaymentRequestMcpInputSchema,
    outputSchema: PaymentRequestMcpOutputSchema,
  },
  {
    name: "buyer_refresh_payment",
    audience: "buyer",
    readOnly: false,
    description:
      "Para el comprador: consulta al proveedor el estado de una solicitud de pago pendiente y lo concilia. Úsalo para ver si ya se confirmó un pago; no puede forzar la confirmación.",
    inputSchema: BuyerRefreshPaymentMcpInputSchema,
    outputSchema: PaymentRequestMcpOutputSchema,
  },
] as const satisfies readonly McpTool[];

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];
export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name) as McpToolName[];

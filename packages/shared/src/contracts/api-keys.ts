import { z } from "zod";
import { IsoDateTimeSchema } from "./common";

/** Visible secret prefix length, e.g. "trk_ab12" (+ ellipsis in the UI). */
export const API_KEY_PREFIX = "trk_";
export const API_KEY_VISIBLE_PREFIX_CHARS = 8;

export const CreateApiKeyInputSchema = z.object({
  label: z.string().trim().min(1, "Ponle un nombre a la llave.").max(60),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;

export const ApiKeyViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** First characters only, e.g. "trk_ab12…". Never enough to authenticate. */
  prefix: z.string(),
  createdAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type ApiKeyView = z.infer<typeof ApiKeyViewSchema>;

export const CreateApiKeyResponseSchema = z.object({
  key: ApiKeyViewSchema,
  /** Full secret, returned exactly once. */
  secret: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;

export const ListApiKeysResponseSchema = z.object({ keys: z.array(ApiKeyViewSchema) });
export type ListApiKeysResponse = z.infer<typeof ListApiKeysResponseSchema>;

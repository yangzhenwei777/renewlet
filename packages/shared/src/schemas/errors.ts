import { z } from "zod";

export const apiErrorCodeSchema = z.string().trim().min(1);

const apiErrorBodySchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
}).strict();

/**
 * Docker、Cloudflare Worker 和前端共享的错误 wire contract。
 *
 * `details` 故意保持 unknown：外层只保证 envelope 稳定，字段级校验、上游 rawResponseText 等细节由业务 schema 再收窄。
 */
export const apiErrorResponseSchema = z.object({
  error: apiErrorBodySchema,
}).strict();

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

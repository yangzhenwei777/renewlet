import { z } from "zod";
import { apiEmptySuccessResponseSchema } from "./api";

/**
 * 无额外业务数据的成功 payload。
 *
 * wire response 统一由 apiSuccessResponseSchema 包裹；payload 本身不再携带 ok。
 */
export const okPayloadSchema = z.object({}).strict();
export const okResponseSchema = apiEmptySuccessResponseSchema;

export type OkResponse = z.infer<typeof okPayloadSchema>;

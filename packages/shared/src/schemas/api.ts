import { z } from "zod";

const emptyDataSchema = z.object({}).strict();

export function apiSuccessResponseSchema<Schema extends z.ZodType>(dataSchema: Schema) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  }).strict();
}

export const apiEmptySuccessResponseSchema = apiSuccessResponseSchema(emptyDataSchema);

export type ApiSuccessResponse<T> = {
  ok: true;
  data: T;
};

export function apiSuccess<T>(data: T): ApiSuccessResponse<T> {
  return { ok: true, data };
}

export function apiEmptySuccess(): ApiSuccessResponse<Record<string, never>> {
  return apiSuccess({});
}

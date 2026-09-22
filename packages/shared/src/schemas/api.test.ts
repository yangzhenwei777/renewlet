import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiEmptySuccess,
  apiEmptySuccessResponseSchema,
  apiSuccess,
  apiSuccessResponseSchema,
} from "./api";

describe("api success envelope", () => {
  it("wraps endpoint payloads in a stable success envelope", () => {
    const schema = apiSuccessResponseSchema(z.object({ subscriptionId: z.string() }).strict());

    expect(schema.parse(apiSuccess({ subscriptionId: "sub_1" }))).toEqual({
      ok: true,
      data: { subscriptionId: "sub_1" },
    });
  });

  it("keeps empty success responses explicit", () => {
    expect(apiEmptySuccessResponseSchema.parse(apiEmptySuccess())).toEqual({
      ok: true,
      data: {},
    });
    expect(apiEmptySuccessResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

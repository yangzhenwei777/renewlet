import { expect } from "vitest";

export async function readSuccessData<T>(response: Response): Promise<T> {
  const body = await response.json() as { ok?: unknown; data?: unknown };
  expect(body.ok).toBe(true);
  expect(body).toHaveProperty("data");
  return body.data as T;
}

import { z } from "zod";

// SecretMutation 是 Go、Worker 与 Web 唯一 write-only secret 更新契约；读取接口只返回 configured，绝不回传 current。

export const secretMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("set"), value: z.string().min(1).max(100_000) }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
]);

export type SecretMutation = z.infer<typeof secretMutationSchema>;

export function resolveSecretMutation(mutation: SecretMutation, current: string): string {
  // current 只存在服务端内存；keep 允许保存非敏感字段时保留既有凭据，set/clear 才产生实际变更。
  if (mutation.action === "keep") return current;
  return mutation.action === "clear" ? "" : mutation.value;
}

import { z } from "zod";
import { apiSuccessResponseSchema } from "./api";

/**
 * 用户自定义配置项契约。
 *
 * labels 是持久化用户文本，不走 Lingui catalog；产品内置分类/状态/货币标签仍必须从 catalog 生成。
 */
export const configItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(80),
  labels: z.object({
    "zh-CN": z.string().trim().min(1).max(80),
    "en-US": z.string().trim().min(1).max(80),
  }),
  color: z.string().trim().max(80).optional(),
  icon: z.string().trim().max(2048).optional(),
  enabled: z.boolean().optional(),
}).strict();

/**
 * 自定义配置响应体的事实来源。
 *
 * 这些数组会驱动订阅表单选项和导入映射，因此上限保护 UI 和导入流程不会被异常配置拖垮。
 */
export const customConfigSchema = z.object({
  categories: z.array(configItemSchema).max(200),
  statuses: z.array(configItemSchema).max(50),
  paymentMethods: z.array(configItemSchema).max(200),
  currencies: z.array(configItemSchema).max(300),
}).strict();

export const customConfigPayloadSchema = z.object({
  config: customConfigSchema,
}).strict();
export const customConfigResponseSchema = apiSuccessResponseSchema(customConfigPayloadSchema);

export type ApiCustomConfig = z.infer<typeof customConfigSchema>;
export type CustomConfigResponse = z.infer<typeof customConfigPayloadSchema>;

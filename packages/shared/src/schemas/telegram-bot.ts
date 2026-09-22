import { z } from "zod";
import { apiSuccessResponseSchema } from "./api";

export const telegramBotCommandsStatusSchema = z.enum(["not_configured", "not_installed", "installing", "installed"]);

export const telegramBotCommandsPayloadSchema = z.object({
  configComplete: z.boolean(),
  installed: z.boolean(),
  status: telegramBotCommandsStatusSchema,
  chatId: z.string().trim().min(1).nullable(),
  installedAt: z.string().trim().min(1).nullable(),
  lastUsedAt: z.string().trim().min(1).nullable(),
}).strict();
export const telegramBotCommandsResponseSchema = apiSuccessResponseSchema(telegramBotCommandsPayloadSchema);

export type TelegramBotCommandsStatus = z.infer<typeof telegramBotCommandsStatusSchema>;
export type TelegramBotCommandsResponse = z.infer<typeof telegramBotCommandsPayloadSchema>;

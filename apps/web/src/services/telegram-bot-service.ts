import { apiFetch } from "@/lib/api-client";
import {
  telegramBotCommandsResponseSchema,
  type TelegramBotCommandsResponse,
} from "@/lib/api/schemas/telegram-bot";
import { okResponseSchema } from "@/lib/api/schemas/common";

export const telegramBotService = {
  async getCommands(signal?: AbortSignal): Promise<TelegramBotCommandsResponse> {
    return await apiFetch(
      "/api/app/telegram-bot/commands",
      telegramBotCommandsResponseSchema,
      signal ? { signal } : undefined,
    );
  },

  async installCommands(): Promise<TelegramBotCommandsResponse> {
    return await apiFetch("/api/app/telegram-bot/commands", telegramBotCommandsResponseSchema, {
      method: "POST",
    });
  },

  async deleteCommands(): Promise<void> {
    await apiFetch("/api/app/telegram-bot/commands", okResponseSchema, { method: "DELETE" });
  },
};

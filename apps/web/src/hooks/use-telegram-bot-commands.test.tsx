import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotCommandsResponse } from "@/lib/api/schemas/telegram-bot";
import { telegramBotService } from "@/services/telegram-bot-service";
import { useTelegramBotCommands } from "./use-telegram-bot-commands";

vi.mock("@/services/telegram-bot-service", () => ({
  telegramBotService: {
    getCommands: vi.fn(),
    installCommands: vi.fn(),
    deleteCommands: vi.fn(),
  },
}));

const QUERY_KEY = ["telegram-bot-commands"] as const;

function commandsResponse(overrides: Partial<TelegramBotCommandsResponse> = {}): TelegramBotCommandsResponse {
  return {
    configComplete: true,
    installed: false,
    status: "not_installed",
    chatId: "12345",
    installedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("use-telegram-bot-commands", () => {
  afterEach(() => {
    vi.mocked(telegramBotService.getCommands).mockReset();
  });

  it("keeps command status cached for a minute and disables focus refetch", async () => {
    const queryClient = createQueryClient();
    vi.mocked(telegramBotService.getCommands).mockResolvedValue(commandsResponse());

    renderHook(() => useTelegramBotCommands(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(telegramBotService.getCommands).toHaveBeenCalledTimes(1));
    expect(telegramBotService.getCommands).toHaveBeenCalledWith(expect.any(AbortSignal));

    const query = queryClient.getQueryCache().find({ queryKey: QUERY_KEY });
    expect(query?.options).toMatchObject({
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    });
  });
});

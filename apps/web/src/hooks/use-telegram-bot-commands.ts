import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { telegramBotService } from "@/services/telegram-bot-service";

const TELEGRAM_BOT_COMMANDS_QUERY_KEY = ["telegram-bot-commands"] as const;

export function useTelegramBotCommands() {
  return useQuery({
    queryKey: TELEGRAM_BOT_COMMANDS_QUERY_KEY,
    queryFn: ({ signal }) => telegramBotService.getCommands(signal),
    // 命令状态不靠窗口聚焦频繁刷新；安装/删除和保存 Telegram 凭据后会显式收敛缓存。
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useInstallTelegramBotCommands() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => telegramBotService.installCommands(),
    onSuccess: (response) => {
      queryClient.setQueryData(TELEGRAM_BOT_COMMANDS_QUERY_KEY, response);
    },
  });
}

export function useDeleteTelegramBotCommands() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => telegramBotService.deleteCommands(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TELEGRAM_BOT_COMMANDS_QUERY_KEY });
    },
  });
}

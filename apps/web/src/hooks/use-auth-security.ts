import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authSecurityService } from "@/services/auth-security-service";
import type { AuthSecuritySettingsUpdateBody, AuthSecurityTurnstileTestBody } from "@/lib/api/schemas/admin";

export const authSecurityQueryKey = ["auth-security"] as const;

export function useAuthSecuritySettings(enabled: boolean) {
  return useQuery({
    queryKey: authSecurityQueryKey,
    queryFn: ({ signal }) => authSecurityService.read(signal),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateAuthSecuritySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AuthSecuritySettingsUpdateBody) => authSecurityService.update(body),
    onSuccess: (settings) => {
      // Turnstile 人机验证是站点级访问安全状态，保存后只缓存脱敏响应，不能触碰账号 settings 草稿。
      queryClient.setQueryData(authSecurityQueryKey, settings);
    },
  });
}

export function useTestAuthSecurityTurnstile() {
  return useMutation({
    // 配置测试只验证当前草稿凭据和一次性 token，不代表保存成功，也不能写入 auth-security query 缓存。
    mutationFn: (body: AuthSecurityTurnstileTestBody) => authSecurityService.testTurnstile(body),
  });
}

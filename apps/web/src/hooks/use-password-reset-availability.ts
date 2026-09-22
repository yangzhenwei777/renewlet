/**
 * 查询当前部署是否启用邮件找回密码。
 *
 * 架构位置：
 * - 登录页只根据该 Hook 的布尔值展示/隐藏“忘记密码”入口。
 * - 服务端状态来自当前运行面的公开 capability，客户端不直接读取任何敏感配置。
 *
 * 注意： 失败时按不可用处理，是为了避免网络抖动时展示一个实际无法完成的找回入口。
 */
import { useEffect, useState } from "react";
import { passwordResetStatusResponseSchema } from "@/lib/api/schemas/app";

/** 返回密码找回能力是否可用；网络失败时按不可用处理。 */
export function usePasswordResetAvailability(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const response = await fetch("/api/app/account/password-reset/status", {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) setEnabled(false);
          return;
        }

        const payload: unknown = await response.json();
        const parsed = passwordResetStatusResponseSchema.safeParse(payload);
        // 登录前接口不走 apiFetch，因此这里必须显式 schema parse；响应漂移时保守隐藏入口。
        if (!cancelled) setEnabled(parsed.success ? parsed.data.data.enabled : false);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}

/**
 * 查询当前部署的认证前应用能力。
 *
 * 失败时按“无需展示初始化入口”处理，避免登录页出现误导性的首次部署提示。
 *
 * 架构位置：
 * - 登录页、setup 页和 Settings demo 置灰都通过该 Hook 读取 app status。
 * - 这是认证前接口，不能依赖 PocketBase 会话状态。
 *
 * 注意：前端能力状态只是体验层，真正的初始化、密钥保存和外发限制仍由后端校验。
 */
import { useEffect, useState } from "react";
import { appStatusResponseSchema } from "@/lib/api/schemas/app";

type SetupStatus = {
  setupRequired: boolean;
  setupEnabled: boolean;
  demoMode: boolean;
  turnstile: {
    enabled: boolean;
    siteKey: string;
  };
  isLoading: boolean;
};

const hiddenSetupStatus: SetupStatus = {
  setupRequired: false,
  setupEnabled: true,
  demoMode: false,
  turnstile: {
    enabled: false,
    siteKey: "",
  },
  isLoading: false,
};

function normalizeSetupStatus(data: { setupRequired: boolean; setupEnabled: boolean; demoMode: boolean; turnstile: { enabled: boolean; siteKey: string } }): Omit<SetupStatus, "isLoading"> {
  return {
    setupRequired: data.setupRequired,
    setupEnabled: data.setupEnabled,
    demoMode: data.demoMode,
    turnstile: data.turnstile,
  };
}

export function useSetupStatus(): SetupStatus {
  const [status, setStatus] = useState<SetupStatus>({
    ...hiddenSetupStatus,
    isLoading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function loadStatus() {
      try {
        const response = await fetch("/api/app/status", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (!cancelled) setStatus(hiddenSetupStatus);
          return;
        }

        const payload: unknown = await response.json();
        const parsed = appStatusResponseSchema.safeParse(payload);
        if (!parsed.success) {
          // app status 影响认证前入口和 demo 置灰；响应不符合契约时按保守能力处理，避免误引导用户。
          if (!cancelled) setStatus(hiddenSetupStatus);
          return;
        }
        if (!cancelled) {
          setStatus({
            ...normalizeSetupStatus(parsed.data.data),
            isLoading: false,
          });
        }
      } catch (error: unknown) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        setStatus(hiddenSetupStatus);
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return status;
}

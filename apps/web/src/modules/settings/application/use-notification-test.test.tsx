// 通知测试 hook 测试保护“未保存设置临时传入服务端”的流程，避免要求用户先保存再测试。
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { toPublicAppSettings } from "@/lib/api/schemas/settings";
import { useNotificationTest } from "./use-notification-test";

type ApiFetchMock = (
  url: string,
  responseSchema: unknown,
  init?: RequestInit,
) => Promise<unknown>;
type AppToast = (typeof import("@/components/ui/sonner"))["toast"];

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<ApiFetchMock>(),
  toast: {
    success: vi.fn<AppToast["success"]>(),
    error: vi.fn<AppToast["error"]>(),
  },
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiFetch: mocks.apiFetch,
  };
});

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

describe("useNotificationTest", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
  });

  it("does not show a loading toast before sending the test notification", async () => {
    mocks.apiFetch.mockResolvedValue({});
    const { result } = renderHook(() => useNotificationTest(DEFAULT_SETTINGS));

    await act(async () => {
      await result.current.testConnection("telegram");
    });

    const call = mocks.apiFetch.mock.calls[0];
    expect(call?.[0]).toBe("/api/app/notifications/test");
    expect(call?.[2]).toEqual({
      method: "POST",
      body: JSON.stringify({
        channel: "telegram",
        settings: { ...toPublicAppSettings(DEFAULT_SETTINGS), secretUpdates: {} },
      }),
      timeoutMs: 20_000,
    });
    expect(mocks.toast.success).not.toHaveBeenCalledWith("正在发送测试通知…");
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith("测试通知发送成功 · Telegram");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("keeps the failure toast after a test notification fails", async () => {
    mocks.apiFetch.mockRejectedValue(new Error("网络错误"));
    const { result } = renderHook(() => useNotificationTest(DEFAULT_SETTINGS));

    await act(async () => {
      await result.current.testConnection("telegram");
    });

    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledWith("测试通知发送失败", {
      description: "网络错误",
    });
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("opens raw response details when a notification test fails", async () => {
    const rawResponse = "{\"error\":{\"message\":\"ServerChan 发送失败\",\"code\":\"NOTIFICATION_TEST_FAILED\",\"details\":{\"rawResponseText\":\"too many requests\"}}}";
    mocks.apiFetch.mockRejectedValue(new ApiError("ServerChan 发送失败", 400, {
      rawResponseText: "too many requests",
    }, "NOTIFICATION_TEST_FAILED", rawResponse));
    const { result } = renderHook(() => useNotificationTest(DEFAULT_SETTINGS));

    await act(async () => {
      await result.current.testConnection("serverchan");
    });

    expect(result.current.errorDetailsOpen).toBe(true);
    expect(result.current.errorDetails).toMatchObject({
      message: "ServerChan 发送失败",
      responseText: "too many requests",
    });
    expect(mocks.toast.error).toHaveBeenCalledWith("测试通知发送失败", {
      description: "ServerChan 发送失败",
    });
  });
});

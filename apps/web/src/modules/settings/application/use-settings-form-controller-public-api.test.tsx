// Public API 与 Telegram command controller 测试独立成文件，避免通用 integrations 测试继续膨胀。
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appSettingsSecretStatus } from "@renewlet/shared/schemas/settings";
import {
  BASE_SETTINGS,
  mocks,
  renderSettingsFormController,
  setupSettingsFormControllerTestEnvironment,
} from "./use-settings-form-controller.test-utils";

describe("useSettingsFormController public API integrations", () => {
  setupSettingsFormControllerTestEnvironment();

  it("creates, copies, and deletes Public API tokens without marking settings dirty", async () => {
    const { result } = renderSettingsFormController();

    expect(result.current.publicApi.tokens.data).toEqual([]);
    expect(result.current.publicApi.tokens.hasData).toBe(true);
    expect(result.current.hasUnsavedChanges).toBe(false);

    await act(async () => {
      await result.current.publicApi.createToken("Telegram Bot");
    });

    expect(mocks.createPublicApiTokenMutateAsync).toHaveBeenCalledWith("Telegram Bot");
    expect(result.current.publicApi.createdPlainToken).toBe("rlt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12");
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.toast.success).toHaveBeenCalledWith("API Token 已创建");

    await act(async () => {
      await result.current.publicApi.copyPlainToken();
    });
    expect(mocks.writeClipboard).toHaveBeenCalledWith("rlt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12");

    act(() => {
      result.current.publicApi.dismissPlainToken();
    });
    expect(result.current.publicApi.createdPlainToken).toBeNull();

    await act(async () => {
      await result.current.publicApi.deleteToken("tok_test");
    });
    expect(mocks.deletePublicApiTokenMutateAsync).toHaveBeenCalledWith("tok_test");
    expect(mocks.toast.success).toHaveBeenCalledWith("API Token 已删除");
  });

  it("refreshes Telegram command status after saved Telegram credentials change", async () => {
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.updateSetting("telegramBotToken", "123456:bot-token");
      result.current.updateSetting("telegramChatId", "123456");
    });

    expect(result.current.telegramBotCommands.installDisabledReason).toBe("Telegram Webhook 需要 HTTPS 外部访问地址。");

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    const command = mocks.updateSettingsMutateAsync.mock.calls.at(0)?.at(0);
    expect(command?.patch.telegramChatId).toBe("123456");
    expect(command?.secretUpdates).toEqual({
      telegramBotToken: { action: "set", value: "123456:bot-token" },
    });
    expect(mocks.telegramBotCommands.refetch).toHaveBeenCalledTimes(1);
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("keeps Telegram install loading out of disabled reason text", () => {
    vi.stubGlobal("location", { ...window.location, protocol: "https:" });
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      telegramChatId: "123456",
    };
    mocks.remoteSecretStatus = appSettingsSecretStatus({
      ...BASE_SETTINGS,
      telegramBotToken: "123456:bot-token",
      telegramChatId: "123456",
    });
    mocks.telegramBotCommands = {
      data: {
        configComplete: true,
        installed: false,
        status: "installing",
        chatId: "123456",
        installedAt: null,
        lastUsedAt: null,
      },
      isLoading: false,
      refetch: vi.fn(),
    };

    const { result } = renderSettingsFormController();

    expect(result.current.telegramBotCommands.isInstalling).toBe(true);
    expect(result.current.telegramBotCommands.installDisabledReason).toBeNull();
  });
});

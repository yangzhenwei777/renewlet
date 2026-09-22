import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthSecuritySettings, useTestAuthSecurityTurnstile, useUpdateAuthSecuritySettings } from "@/hooks/use-auth-security";
import { toast } from "@/components/ui/sonner";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useI18n } from "@/i18n/I18nProvider";
import type { AuthSecuritySettings } from "@/lib/api/schemas/admin";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

export interface AuthSecurityTurnstileDraft {
  enabled: boolean;
  siteKey: string;
  secret: string;
}

export interface SettingsAuthSecurityController {
  canManage: boolean;
  disabled: boolean;
  readState: SettingsReadState<AuthSecuritySettings>;
  isSaving: boolean;
  isClearingSecret: boolean;
  isTesting: boolean;
  secretConfigured: boolean;
  hasChanges: boolean;
  draft: AuthSecurityTurnstileDraft;
  testDialogOpen: boolean;
  testDialogSiteKey: string;
  testResetSignal: number;
  testError: string | undefined;
  setEnabled: (enabled: boolean) => void;
  setSiteKey: (siteKey: string) => void;
  setSecret: (secret: string) => void;
  discard: () => void;
  save: () => Promise<void>;
  clearSecret: () => Promise<void>;
  startTest: () => void;
  handleTestDialogOpenChange: (open: boolean) => void;
  handleTestTokenChange: (token: string) => void;
}

const emptyDraft: AuthSecurityTurnstileDraft = {
  enabled: false,
  siteKey: "",
  secret: "",
};

type TurnstileTestState = "idle" | "challenge" | "verifying";

interface TurnstileTestSnapshot {
  siteKey: string;
  secret?: string | undefined;
}

/**
 * 访问安全是站点级管理员配置，不参与账号 settings 草稿；secret 输入始终 write-only。
 */
export function useAuthSecuritySettingsController(canManage: boolean, disabled: boolean): SettingsAuthSecurityController {
  const { t } = useI18n();
  const query = useAuthSecuritySettings(canManage);
  const update = useUpdateAuthSecuritySettings();
  const testTurnstile = useTestAuthSecurityTurnstile();
  const [draft, setDraft] = useState<AuthSecurityTurnstileDraft>(emptyDraft);
  const [savedDraft, setSavedDraft] = useState<AuthSecurityTurnstileDraft>(emptyDraft);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [clearingSecret, setClearingSecret] = useState(false);
  const [testState, setTestState] = useState<TurnstileTestState>("idle");
  const [testSnapshot, setTestSnapshot] = useState<TurnstileTestSnapshot | null>(null);
  const [testResetSignal, setTestResetSignal] = useState(0);
  const [testError, setTestError] = useState<string | undefined>(undefined);
  const dirtyRef = useRef(false);
  const previousTestInputRef = useRef({ siteKey: emptyDraft.siteKey, secret: emptyDraft.secret });
  // Siteverify 是异步且会消费 token；会话号让关闭弹窗或字段变更后的迟到结果只能被丢弃。
  const testSessionRef = useRef(0);

  const hasChanges = useMemo(
    // savedDraft 永远不保存真实 secret；只要 secret 输入非空就视为一次 write-only 更新。
    () => draft.enabled !== savedDraft.enabled || draft.siteKey !== savedDraft.siteKey || draft.secret.trim().length > 0,
    [draft, savedDraft],
  );

  useEffect(() => {
    dirtyRef.current = hasChanges;
  }, [hasChanges]);

  const resetTurnstileTest = useCallback(() => {
    testSessionRef.current += 1;
    setTestState("idle");
    setTestSnapshot(null);
    setTestError(undefined);
    setTestResetSignal((value) => value + 1);
  }, []);

  useEffect(() => {
    const remote = query.data?.turnstile;
    if (!remote || dirtyRef.current) return;
    // 远端响应只含 secretConfigured；用户编辑中时不让后台刷新覆盖本地草稿或清掉待提交 secret。
    const nextDraft = {
      enabled: remote.enabled,
      siteKey: remote.siteKey,
      secret: "",
    };
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setSecretConfigured(remote.secretConfigured);
  }, [query.data]);

  useEffect(() => {
    const previous = previousTestInputRef.current;
    previousTestInputRef.current = { siteKey: draft.siteKey, secret: draft.secret };
    if (testState === "idle") return;
    if (previous.siteKey === draft.siteKey && previous.secret === draft.secret) return;
    // Turnstile token 绑定生成它的 siteKey，secret 也只对当前测试有效；字段变更后必须丢弃旧挑战。
    resetTurnstileTest();
  }, [draft.secret, draft.siteKey, resetTurnstileTest, testState]);

  const setEnabled = useCallback((enabled: boolean) => {
    if (disabled) return;
    setDraft((current) => ({ ...current, enabled }));
  }, [disabled]);

  const setSiteKey = useCallback((siteKey: string) => {
    if (disabled) return;
    setDraft((current) => ({ ...current, siteKey }));
  }, [disabled]);

  const setSecret = useCallback((secret: string) => {
    if (disabled) return;
    setDraft((current) => ({ ...current, secret }));
  }, [disabled]);

  const discard = useCallback(() => {
    setDraft(savedDraft);
    resetTurnstileTest();
  }, [resetTurnstileTest, savedDraft]);

  const save = useCallback(async () => {
    if (!canManage || disabled || update.isPending) return;
    const siteKey = draft.siteKey.trim();
    const secret = draft.secret.trim();
    if (draft.enabled && (!siteKey || (!secretConfigured && !secret))) {
      toast.error(t("settings.turnstileSaveFailed"), { description: t("settings.turnstileIncomplete") });
      return;
    }
    try {
      const response = await update.mutateAsync({
        turnstile: {
          enabled: draft.enabled,
          siteKey,
          // secret 省略表示保留服务端旧值；不能把空输入当作清空，否则会误关已启用站点。
          ...(secret ? { secret } : {}),
        },
      });
      const nextDraft = {
        enabled: response.turnstile.enabled,
        siteKey: response.turnstile.siteKey,
        secret: "",
      };
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setSecretConfigured(response.turnstile.secretConfigured);
      resetTurnstileTest();
      toast.success(t("settings.turnstileSaved"));
    } catch (error) {
      toast.error(t("settings.turnstileSaveFailed"), {
        description: getDisplayErrorMessage(error, t("settings.turnstileSaveFailedDescription")),
      });
    }
  }, [canManage, disabled, draft.enabled, draft.secret, draft.siteKey, resetTurnstileTest, secretConfigured, t, update]);

  const clearSecret = useCallback(async () => {
    if (!canManage || disabled || update.isPending || !secretConfigured) return;
    setClearingSecret(true);
    try {
      const response = await update.mutateAsync({
        turnstile: {
          // 清空 secret 会让完整配置失效，必须同时关闭开关，避免登录页展示无法通过的挑战。
          enabled: false,
          siteKey: draft.siteKey.trim(),
          secret: "",
        },
      });
      const nextDraft = {
        enabled: response.turnstile.enabled,
        siteKey: response.turnstile.siteKey,
        secret: "",
      };
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setSecretConfigured(response.turnstile.secretConfigured);
      resetTurnstileTest();
      toast.success(t("settings.turnstileSecretCleared"));
    } catch (error) {
      toast.error(t("settings.turnstileSaveFailed"), {
        description: getDisplayErrorMessage(error, t("settings.turnstileSaveFailedDescription")),
      });
    } finally {
      setClearingSecret(false);
    }
  }, [canManage, disabled, draft.siteKey, resetTurnstileTest, secretConfigured, t, update]);

  const startTest = useCallback(() => {
    if (!canManage || disabled || update.isPending || testTurnstile.isPending) return;
    const siteKey = draft.siteKey.trim();
    const secret = draft.secret.trim();
    if (!siteKey || (!secret && !secretConfigured)) {
      toast.error(t("settings.turnstileTestFailed"), { description: t("settings.turnstileIncomplete") });
      return;
    }
    // 测试使用当前页面草稿：secret 非空就试新值，留空才让后端回退已保存 secret。
    testSessionRef.current += 1;
    setTestSnapshot({ siteKey, ...(secret ? { secret } : {}) });
    setTestError(undefined);
    setTestState("challenge");
    setTestResetSignal((value) => value + 1);
  }, [canManage, disabled, draft.secret, draft.siteKey, secretConfigured, t, testTurnstile.isPending, update.isPending]);

  const handleTestDialogOpenChange = useCallback((open: boolean) => {
    // Radix 会把 close/open 都回调到这里；打开挑战只能走 startTest，确保先完成本地凭据校验和快照。
    if (open) return;
    resetTurnstileTest();
  }, [resetTurnstileTest]);

  const handleTestTokenChange = useCallback((token: string) => {
    const responseToken = token.trim();
    if (!responseToken || testState !== "challenge" || !testSnapshot) return;
    const testSession = testSessionRef.current;
    setTestState("verifying");
    void testTurnstile.mutateAsync({
      turnstile: {
        siteKey: testSnapshot.siteKey,
        ...(testSnapshot.secret ? { secret: testSnapshot.secret } : {}),
        turnstileToken: responseToken,
      },
    }).then(() => {
      if (testSessionRef.current !== testSession) return;
      toast.success(t("settings.turnstileTestPassed"));
      resetTurnstileTest();
    }).catch((error: unknown) => {
      // 弹窗关闭或字段变更会丢弃测试会话；迟到的 Siteverify 结果不能重新打开旧挑战。
      if (testSessionRef.current !== testSession) return;
      const description = getDisplayErrorMessage(error, t("settings.turnstileTestFailedDescription"));
      setTestError(description);
      setTestState("challenge");
      // Siteverify 会消费 token；失败后必须重置当前 widget，等待 Cloudflare 生成新 token。
      setTestResetSignal((value) => value + 1);
      toast.error(t("settings.turnstileTestFailed"), { description });
    });
  }, [resetTurnstileTest, t, testSnapshot, testState, testTurnstile]);

  return {
    canManage,
    disabled,
    readState: toSettingsReadState(query),
    isSaving: update.isPending && !clearingSecret,
    isClearingSecret: clearingSecret,
    isTesting: testState === "verifying" || testTurnstile.isPending,
    secretConfigured,
    hasChanges,
    draft,
    testDialogOpen: testState !== "idle" && Boolean(testSnapshot?.siteKey),
    testDialogSiteKey: testSnapshot?.siteKey ?? "",
    testResetSignal,
    testError,
    setEnabled,
    setSiteKey,
    setSecret,
    discard,
    save,
    clearSecret,
    startTest,
    handleTestDialogOpenChange,
    handleTestTokenChange,
  };
}

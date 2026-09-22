import { useCallback, useMemo, useState } from "react";
import { aiRecognitionSettingsSchema } from "@renewlet/shared/schemas/ai-recognition";
import type { AppSettings } from "@/types/subscription";
import type {
  SettingsSecretKey,
  SettingsSecretUpdates,
} from "@/lib/api/schemas/settings";
import {
  applySecretDraftsToSettings,
  settingsSecretUpdatesFromDrafts,
  topLevelSettingsSecretKey,
  withoutSecretKey,
  type SettingsSecretDrafts,
} from "@/services/settings-secrets";

type StageSecretResult = "not-secret" | "staged" | "blocked";

interface SettingsSecretDraftController {
  drafts: SettingsSecretDrafts;
  cleared: ReadonlySet<SettingsSecretKey>;
  settingsWithDrafts: AppSettings;
  dirty: boolean;
  stageSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => StageSecretResult;
  clear: (key: SettingsSecretKey) => void;
  updates: () => SettingsSecretUpdates;
  reset: () => void;
}

/**
 * Secret 输入与公共 settings 草稿分开保存；远端 refetch 只能替换公共基线，不能把空的
 * write-only 响应覆盖到用户正在编辑的 token、URL 或密码。
 */
export function useSettingsSecretDrafts(
  settings: AppSettings,
  disabled: boolean,
): SettingsSecretDraftController {
  const [drafts, setDrafts] = useState<SettingsSecretDrafts>({});
  const [cleared, setCleared] = useState<Set<SettingsSecretKey>>(() => new Set());
  const settingsWithDrafts = useMemo(
    () => applySecretDraftsToSettings(settings, drafts),
    [drafts, settings],
  );
  const dirty = useMemo(
    () => Object.values(drafts).some(Boolean) || cleared.size > 0,
    [cleared, drafts],
  );

  const stageSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]): StageSecretResult => {
    const secretKey = topLevelSettingsSecretKey(key);
    const aiSecretKey = key === "aiRecognition" ? "aiRecognition.apiKey" : null;
    if (!secretKey && !aiSecretKey) return "not-secret";
    if (disabled) return "blocked";

    const targetKey: SettingsSecretKey = secretKey ?? "aiRecognition.apiKey";
    const nextValue = secretKey
      ? String(value)
      : aiRecognitionSettingsSchema.parse(value).apiKey;
    if (nextValue) {
      setDrafts((current) => ({ ...current, [targetKey]: nextValue }));
      setCleared((current) => withoutSecretKey(current, targetKey));
    } else {
      // 清空尚未保存的输入只撤销本地 set 草稿；删除已配置 secret 必须走显式 clear 动作。
      setDrafts((current) => {
        const next = { ...current };
        delete next[targetKey];
        return next;
      });
    }
    return "staged";
  }, [disabled]);

  const clear = useCallback((key: SettingsSecretKey) => {
    if (disabled) return;
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setCleared((current) => new Set(current).add(key));
  }, [disabled]);

  const updates = useCallback(
    () => settingsSecretUpdatesFromDrafts(drafts, cleared),
    [cleared, drafts],
  );

  const reset = useCallback(() => {
    setDrafts({});
    setCleared(new Set());
  }, []);

  return {
    drafts,
    cleared,
    settingsWithDrafts,
    dirty,
    stageSetting,
    clear,
    updates,
    reset,
  };
}

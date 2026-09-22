import { useCallback, useState } from "react";
import { useCreatePublicApiToken, useDeletePublicApiToken, usePublicApiTokens } from "@/hooks/use-public-api-tokens";
import { toast } from "@/components/ui/sonner";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { copyTextToClipboard, type ClipboardCopyTarget } from "@/shared/browser/clipboard";
import type { ApiToken } from "@/lib/api/schemas/public-api";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

export interface SettingsPublicApiController {
  tokens: SettingsReadState<ApiToken[]>;
  createdPlainToken: string | null;
  isCreating: boolean;
  deletingTokenId: string | null;
  createToken: (name: string) => Promise<boolean>;
  copyPlainToken: (target?: ClipboardCopyTarget | null) => Promise<void>;
  dismissPlainToken: () => void;
  deleteToken: (id: string) => Promise<boolean>;
}

export function usePublicApiSettingsController(): SettingsPublicApiController {
  const { t } = useI18n();
  const tokensQuery = usePublicApiTokens();
  const createTokenMutation = useCreatePublicApiToken();
  const deleteTokenMutation = useDeletePublicApiToken();
  const [createdPlainToken, setCreatedPlainToken] = useState<string | null>(null);

  const createToken = useCallback(async (name: string) => {
    try {
      const response = await createTokenMutation.mutateAsync(name);
      // plainToken 是一次性明文，离开这一段 UI 后只能重新创建；不要写入 settings 草稿或持久缓存。
      setCreatedPlainToken(response.plainToken);
      toast.success(t("settings.publicApiCreated"));
      return true;
    } catch (error) {
      toast.error(t("settings.publicApiCreateFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicApiCreateFailedDescription")),
      });
      return false;
    }
  }, [createTokenMutation, t]);

  const copyPlainToken = useCallback(async (target?: ClipboardCopyTarget | null) => {
    if (!createdPlainToken) return;
    const copyResult = await copyTextToClipboard(createdPlainToken, { target });
    if (copyResult.ok) {
      toast.success(t("settings.publicApiTokenCopied"));
      return;
    }
    toast.error(t("settings.publicApiCopyFailed"), {
      description: t("settings.publicApiCopyFailedDescription"),
    });
  }, [createdPlainToken, t]);

  const deleteToken = useCallback(async (id: string) => {
    try {
      await deleteTokenMutation.mutateAsync(id);
      toast.success(t("settings.publicApiDeleted"));
      return true;
    } catch (error) {
      toast.error(t("settings.publicApiDeleteFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicApiDeleteFailedDescription")),
      });
      return false;
    }
  }, [deleteTokenMutation, t]);

  return {
    tokens: toSettingsReadState(tokensQuery),
    createdPlainToken,
    isCreating: createTokenMutation.isPending,
    deletingTokenId: deleteTokenMutation.isPending ? deleteTokenMutation.variables ?? null : null,
    createToken,
    copyPlainToken,
    dismissPlainToken: () => setCreatedPlainToken(null),
    deleteToken,
  };
}

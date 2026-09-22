import { useCallback } from "react";
import {
  useCreatePublicStatusPage,
  useDeletePublicStatusPage,
  usePublicStatusPageStatus,
  useUpdatePublicStatusPage,
} from "@/hooks/use-public-status-page";
import { toast } from "@/components/ui/sonner";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { copyTextToClipboard, type ClipboardCopyTarget } from "@/shared/browser/clipboard";
import type { PublicStatusPage } from "@/lib/api/schemas/public-status";
import type { SubscriptionFacets } from "@/services/subscription-service";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

export interface SettingsPublicStatusPageController {
  status: SettingsReadState<PublicStatusPage>;
  visibility: SettingsReadState<{ visibleCount: number; hiddenCount: number }>;
  isCreating: boolean;
  isDeleting: boolean;
  isUpdating: boolean;
  createOrRotate: () => Promise<void>;
  copyUrl: (target?: ClipboardCopyTarget | null) => Promise<void>;
  openPage: () => Promise<void>;
  regenerate: () => Promise<boolean>;
  revoke: () => Promise<boolean>;
  updateShowPrices: (checked: boolean) => Promise<void>;
}

export function usePublicStatusPageSettingsController(
  facets: SettingsReadState<SubscriptionFacets>,
): SettingsPublicStatusPageController {
  const { t } = useI18n();
  const publicStatusPageStatus = usePublicStatusPageStatus();
  const createPublicStatusPage = useCreatePublicStatusPage();
  const updatePublicStatusPage = useUpdatePublicStatusPage();
  const deletePublicStatusPage = useDeletePublicStatusPage();
  const visibility = {
    ...facets,
    data: facets.data ? {
      visibleCount: facets.data.visibleCount,
      hiddenCount: facets.data.hiddenCount,
    } : undefined,
  } satisfies SettingsReadState<{ visibleCount: number; hiddenCount: number }>;

  const handleCreatePublicStatusPage = useCallback(async () => {
    try {
      // 公开页 token 是 bearer secret；创建成功后立即更新缓存，避免复制到旧地址或空地址。
      await createPublicStatusPage.mutateAsync();
      toast.success(t("settings.publicStatusGenerated"));
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusFailedDescription")),
      });
    }
  }, [createPublicStatusPage, t]);

  const handleCopyPublicStatusUrl = useCallback(async (target?: ClipboardCopyTarget | null) => {
    const pageUrl = publicStatusPageStatus.data?.pageUrl;
    if (!pageUrl) return;
    const copyResult = await copyTextToClipboard(pageUrl, { target });
    if (copyResult.ok) {
      toast.success(t("settings.publicStatusCopied"));
      return;
    }
    toast.error(t("settings.publicStatusCopyFailed"), {
      description: t("settings.publicStatusCopyFailedDescription"),
    });
  }, [publicStatusPageStatus.data?.pageUrl, t]);

  const handleOpenPublicStatusPage = useCallback(async () => {
    const pageUrl = publicStatusPageStatus.data?.pageUrl;
    if (!pageUrl) return;
    window.open(pageUrl, "_blank", "noopener,noreferrer");
  }, [publicStatusPageStatus.data?.pageUrl]);

  const handleRevokePublicStatusPage = useCallback(async () => {
    try {
      // 撤销的安全边界在服务端删除 token；前端缓存只是让设置页立刻停止显示旧 URL。
      await deletePublicStatusPage.mutateAsync();
      toast.success(t("settings.publicStatusRevoked"));
      return true;
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusRevokeFailedDescription")),
      });
      return false;
    }
  }, [deletePublicStatusPage, t]);

  const handleRegeneratePublicStatusPage = useCallback(async () => {
    try {
      // 轮换采用先撤销后创建；只有旧 token 已失效后，设置页才展示新公开页 URL。
      await deletePublicStatusPage.mutateAsync();
      await createPublicStatusPage.mutateAsync();
      toast.success(t("settings.publicStatusRegenerated"));
      return true;
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusFailedDescription")),
      });
      return false;
    }
  }, [createPublicStatusPage, deletePublicStatusPage, t]);

  const handleUpdatePublicStatusShowPrices = useCallback(async (checked: boolean) => {
    if (!publicStatusPageStatus.data?.enabled) return;
    try {
      await updatePublicStatusPage.mutateAsync(checked);
      toast.success(checked ? t("settings.publicStatusPricesEnabled") : t("settings.publicStatusPricesDisabled"));
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusUpdateFailedDescription")),
      });
    }
  }, [publicStatusPageStatus.data?.enabled, t, updatePublicStatusPage]);

  return {
    status: toSettingsReadState(publicStatusPageStatus),
    visibility,
    isCreating: createPublicStatusPage.isPending,
    isDeleting: deletePublicStatusPage.isPending,
    isUpdating: updatePublicStatusPage.isPending,
    createOrRotate: handleCreatePublicStatusPage,
    copyUrl: handleCopyPublicStatusUrl,
    openPage: handleOpenPublicStatusPage,
    regenerate: handleRegeneratePublicStatusPage,
    revoke: handleRevokePublicStatusPage,
    updateShowPrices: handleUpdatePublicStatusShowPrices,
  };
}

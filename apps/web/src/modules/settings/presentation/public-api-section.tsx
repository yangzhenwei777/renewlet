import { useRef, useState } from "react";
import { Clipboard, KeyRound, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { FormField, FormFieldRow, FormFieldRowAction } from "@/components/ui/form-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/i18n/I18nProvider";
import type { ApiToken } from "@/lib/api/schemas/public-api";
import type { SettingsPublicApiController } from "../application/use-public-api-settings-controller";
import { LoadingButtonContent } from "./settings-shared-controls";
import { getSettingsSectionClassName } from "./settings-layout";
import { ManagerDataBoundary } from "./manager-data-boundary";
import { SettingsManagerDialogFrame } from "./settings-manager-dialog-frame";
import { SettingsSectionHeader } from "./settings-section-header";

interface PublicApiSectionProps {
  id?: string;
  className?: string;
  controller: SettingsPublicApiController;
}

export function PublicApiSection({ id, className, controller }: PublicApiSectionProps) {
  const { t, formatDateTime } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [tokenToDelete, setTokenToDelete] = useState<ApiToken | null>(null);
  const plainTokenInputRef = useRef<HTMLInputElement>(null);
  const tokenNameInputRef = useRef<HTMLInputElement>(null);
  const busy = controller.isCreating || controller.deletingTokenId !== null;
  const tokens = controller.tokens.data ?? [];
  const tokenCount = tokens.length;
  const tokenSummary = controller.tokens.isInitialLoading
    ? t("settings.publicApiTokensLoading")
    : !controller.tokens.hasData && controller.tokens.error
      ? t("settings.publicApiTokensLoadFailed")
      : controller.tokens.error
        ? t("settings.publicApiSummaryStale", { count: tokenCount })
        : t("settings.publicApiTokenCount", { count: tokenCount });

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const created = await controller.createToken(trimmed);
    if (created) setName("");
  };
  const formatTokenTime = (value: string | null | undefined, fallback: string) => {
    if (!value) return fallback;
    return formatDateTime(value, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const handleDialogOpenChange = (open: boolean) => {
    // 一次性明文 token 只返回一次；误关弹窗不能清空它，否则用户只能重新创建 token。
    setDialogOpen(open);
  };

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <SettingsSectionHeader
        icon={<KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
        title={t("settings.publicApi")}
        help={t("settings.publicApiHelp")}
        summary={tokenSummary}
        status={controller.createdPlainToken ? (
          <Badge variant="default" className="w-fit">{t("settings.publicApiPendingPlainToken")}</Badge>
        ) : undefined}
        action={(
          <Button type="button" variant="outline" size="sm" className="w-full gap-2 border-border sm:w-auto" onClick={() => setDialogOpen(true)}>
            <SlidersHorizontal className="h-4 w-4" />
            {t("settings.publicApiManage")}
          </Button>
        )}
      />

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <SettingsManagerDialogFrame
          icon={<KeyRound className="h-5 w-5 text-primary" />}
          title={t("settings.publicApiDialogTitle")}
          description={t("settings.publicApiDialogDescription")}
          footer={(
            <Button type="button" onClick={() => setDialogOpen(false)} className="w-full sm:w-auto">
              {t("settings.publicApiDialogDone")}
            </Button>
          )}
        >
            <div className="grid gap-5">
              {controller.createdPlainToken ? (
                <div className="grid gap-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-foreground">{t("settings.publicApiPlainToken")}</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("settings.publicApiPlainTokenHelp")}</p>
                    </div>
                    <Button type="button" variant="ghost" size="icon" onClick={controller.dismissPlainToken} aria-label={t("settings.publicApiDismissPlainToken")} className="h-8 w-8 shrink-0">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                    <Input ref={plainTokenInputRef} value={controller.createdPlainToken} readOnly className="border-border bg-background font-mono text-xs" aria-label={t("settings.publicApiPlainToken")} />
                    <Button
                      type="button"
                      variant="default"
                      onClick={() => {
                        void controller.copyPlainToken(plainTokenInputRef.current);
                      }}
                      className="justify-center gap-2"
                    >
                      <Clipboard className="h-4 w-4" />
                      {t("settings.publicApiCopyToken")}
                    </Button>
                  </div>
                </div>
              ) : null}

              <FormFieldRow
                alignAt="sm"
                rowClassName="sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <FormField
                  id="public-api-token-name"
                  label={t("settings.publicApiCreateName")}
                  description={t("settings.publicApiCreateHelp")}
                  descriptionClassName="leading-5"
                >
                  {({ id, describedBy }) => (
                    <Input
                      ref={tokenNameInputRef}
                      id={id}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t("settings.publicApiCreateNamePlaceholder")}
                      maxLength={80}
                      disabled={busy}
                      className="border-border bg-secondary"
                      aria-describedby={describedBy}
                    />
                  )}
                </FormField>
                <FormFieldRowAction>
                  <Button
                    type="button"
                    onClick={() => {
                      void handleCreate();
                    }}
                    disabled={busy || name.trim().length === 0}
                    aria-busy={controller.isCreating ? true : undefined}
                    className="w-full justify-center gap-2 sm:w-auto"
                  >
                    <LoadingButtonContent loading={controller.isCreating} loadingLabel={t("common.saving")}>
                      <Plus className="h-4 w-4" />
                      {t("settings.publicApiCreate")}
                    </LoadingButtonContent>
                  </Button>
                </FormFieldRowAction>
              </FormFieldRow>

              <div className="grid gap-3 border-t border-border pt-4">
                <ManagerDataBoundary state={controller.tokens}>
                  {tokens.length === 0 ? (
                    <p className="text-sm leading-6 text-muted-foreground">{t("settings.publicApiTokensEmpty")}</p>
                  ) : (
                    <div className="grid gap-2" role="list" aria-label={t("settings.publicApiTokens")}>
                    {tokens.map((token) => (
                      <div key={token.id} role="listitem" className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-medium text-foreground">{token.name}</h3>
                            <Badge variant="secondary" className="font-mono">{token.tokenPrefix}</Badge>
                          </div>
                          <div className="mt-2 grid gap-1 text-xs leading-5 text-muted-foreground">
                            <span>{t("settings.publicApiTokenScopes", { scopes: token.scopes.join(", ") })}</span>
                            <span>{t("settings.publicApiTokenCreated", { time: formatTokenTime(token.createdAt, t("settings.publicApiTokenUnknownTime")) })}</span>
                            <span>{t("settings.publicApiTokenLastUsed", { time: formatTokenTime(token.lastUsedAt, t("settings.publicApiTokenNeverUsed")) })}</span>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setTokenToDelete(token)}
                          disabled={busy}
                          aria-busy={controller.deletingTokenId === token.id ? true : undefined}
                          aria-label={t("settings.publicApiDeleteNamed", { name: token.name })}
                          className="justify-center gap-2 text-destructive hover:text-destructive"
                        >
                          <LoadingButtonContent loading={controller.deletingTokenId === token.id} loadingLabel={t("common.saving")}>
                            <Trash2 className="h-4 w-4" />
                            {t("settings.publicApiDelete")}
                          </LoadingButtonContent>
                        </Button>
                      </div>
                    ))}
                  </div>
                  )}
                </ManagerDataBoundary>
              </div>
            </div>
        </SettingsManagerDialogFrame>
      </Dialog>

      <AlertDialog
        open={Boolean(tokenToDelete)}
        onOpenChange={(open) => {
          if (!open && controller.deletingTokenId === null) setTokenToDelete(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            tokenNameInputRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.publicApiDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.publicApiDeleteDescription", { name: tokenToDelete?.name ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={controller.deletingTokenId !== null}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={controller.deletingTokenId !== null}
              aria-busy={controller.deletingTokenId !== null ? true : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (!tokenToDelete) return;
                void controller.deleteToken(tokenToDelete.id).then((deleted) => {
                  if (deleted) setTokenToDelete(null);
                });
              }}
            >
              <LoadingButtonContent loading={controller.deletingTokenId !== null} loadingLabel={t("common.saving")}>
                {t("settings.publicApiDelete")}
              </LoadingButtonContent>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

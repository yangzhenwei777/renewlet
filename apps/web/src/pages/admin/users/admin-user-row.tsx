/**
 * 管理员用户表格行。
 *
 * 架构位置：只渲染单个用户的 role/status/action 控件；真正的权限和防自锁检查由页面 controller
 * 与后端 admin route 双重兜底。
 *
 * 注意： 前端禁用是体验层保护，不可替代后端“至少保留一个管理员”的约束。
 */
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nProvider";
import type { AdminUser, UserRole } from "@/lib/api/schemas/admin";
import { isEnabledAdmin } from "./types";

export interface AdminUserRowProps {
  user: AdminUser;
  currentUserId: string | undefined;
  enabledAdminCount: number;
  isUpdating: boolean;
  onRoleChange: (user: AdminUser, role: UserRole) => void;
  onStatusChange: (user: AdminUser, enabled: boolean) => void;
  onResetPassword: (user: AdminUser) => void;
  onResetMfa: (user: AdminUser) => void;
  onResetPasskeys: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
}

export function AdminUserRow({
  user,
  currentUserId,
  enabledAdminCount,
  isUpdating,
  onRoleChange,
  onStatusChange,
  onResetPassword,
  onResetMfa,
  onResetPasskeys,
  onDelete,
}: AdminUserRowProps) {
  const { t } = useI18n();
  const isCurrentUser = user.id === currentUserId;
  const isLastEnabledAdmin = isEnabledAdmin(user) && enabledAdminCount <= 1;
  // 前端提前禁用会造成更清晰的操作反馈；后端仍会重复校验，防止绕过 UI 造成系统无管理员。
  const protectionMessage = isCurrentUser
    ? t("admin.currentUserProtected")
    : isLastEnabledAdmin
      ? t("admin.lastAdmin")
      : undefined;
  const protectedMessageId = protectionMessage ? "admin-user-" + user.id + "-protection" : undefined;
  const shouldDisableRoleAndStatus = isUpdating || isCurrentUser || isLastEnabledAdmin;
  const shouldDisableDelete = isUpdating || isCurrentUser || isLastEnabledAdmin;
  const shouldDisableMfaReset = isUpdating || isCurrentUser || !user.mfaEnabled;
  const shouldDisablePasskeysReset = isUpdating || isCurrentUser || !user.passkeysEnabled;
  const passwordActionLabel = isCurrentUser ? t("settings.changePassword") : t("admin.resetPassword");
  const mfaMethodCount = user.mfaMethods.length;

  return (
    <div className="border-b border-border px-4 py-5 last:border-b-0 sm:px-5 lg:grid lg:grid-cols-[minmax(0,1fr)_120px_108px_132px_132px_430px] lg:items-center lg:gap-4 lg:py-4">
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{user.name}</div>
        <div className="wrap-break-word text-sm text-muted-foreground">{user.email}</div>
        {protectionMessage ? (
          <p id={protectedMessageId} className="mt-1 text-xs text-muted-foreground">
            {protectionMessage}
          </p>
        ) : null}
      </div>
      <div className="mt-4 grid gap-2 lg:mt-0 lg:gap-0">
        <span className="text-xs font-medium text-muted-foreground lg:hidden">{t("admin.role")}</span>
        <Select
          value={user.role === "admin" ? "admin" : "user"}
          disabled={shouldDisableRoleAndStatus}
          onValueChange={(nextRole) => onRoleChange(user, nextRole === "admin" ? "admin" : "user")}
        >
          <SelectTrigger aria-label={t("admin.role")} aria-describedby={protectedMessageId} className="min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">{t("admin.roleUser")}</SelectItem>
            <SelectItem value="admin">{t("admin.roleAdmin")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2 lg:mt-0 lg:justify-start lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0">
        <span className="text-xs font-medium text-muted-foreground lg:hidden">{t("admin.status")}</span>
        <div className="flex items-center gap-2">
          <Switch
            checked={!user.banned}
            disabled={shouldDisableRoleAndStatus}
            aria-label={t("admin.status")}
            aria-describedby={protectedMessageId}
            onCheckedChange={(enabled) => onStatusChange(user, enabled)}
          />
          <span className="text-sm text-muted-foreground">{user.banned ? t("admin.banned") : t("admin.enabled")}</span>
        </div>
      </div>
      <div className="mt-4 grid gap-2 lg:mt-0 lg:gap-0">
        <span className="text-xs font-medium text-muted-foreground lg:hidden">{t("admin.mfa")}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={user.mfaEnabled ? "default" : "secondary"} className="gap-1">
            <ShieldCheck className="h-3 w-3" aria-hidden="true" />
            {user.mfaEnabled ? t("admin.mfaEnabled") : t("admin.mfaDisabled")}
          </Badge>
          {user.mfaEnabled ? (
            <span className="text-xs text-muted-foreground">{t("admin.mfaMethodCount", { count: mfaMethodCount })}</span>
          ) : null}
        </div>
      </div>
      <div className="mt-4 grid gap-2 lg:mt-0 lg:gap-0">
        <span className="text-xs font-medium text-muted-foreground lg:hidden">{t("admin.passkeys")}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={user.passkeysEnabled ? "default" : "secondary"} className="gap-1">
            <KeyRound className="h-3 w-3" aria-hidden="true" />
            {user.passkeysEnabled ? t("admin.passkeysEnabled") : t("admin.passkeysDisabled")}
          </Badge>
          {user.passkeysEnabled ? (
            <span className="text-xs text-muted-foreground">{t("admin.passkeyCount", { count: user.passkeyCount })}</span>
          ) : null}
        </div>
      </div>
      <div className="mt-4 grid gap-2 lg:mt-0 lg:gap-0">
        <span className="text-xs font-medium text-muted-foreground lg:hidden">{t("admin.actions")}</span>
        <div className="grid gap-2 lg:grid-cols-2">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={isUpdating}
            onClick={() => onResetPassword(user)}
          >
            {passwordActionLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={shouldDisableMfaReset}
            aria-describedby={protectedMessageId}
            onClick={() => onResetMfa(user)}
          >
            <ShieldCheck className="h-4 w-4" />
            {t("admin.resetMfa")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={shouldDisablePasskeysReset}
            aria-describedby={protectedMessageId}
            onClick={() => onResetPasskeys(user)}
          >
            <KeyRound className="h-4 w-4" />
            {t("admin.resetPasskeys")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full"
            disabled={shouldDisableDelete}
            aria-describedby={protectedMessageId}
            onClick={() => onDelete(user)}
          >
            <Trash2 className="h-4 w-4" />
            {t("common.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}

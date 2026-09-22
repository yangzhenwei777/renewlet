/**
 * 法务/声明类页面外壳。
 *
 * 架构位置：
 * - 登录页可链接到无需登录的 terms/privacy 页面。
 * - 本组件统一品牌区、正文容器和返回入口。
 */
import Link from '@/components/router-link';
import type { ReactNode } from "react";
import { ArrowLeft, Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RenewletBrandLockup } from "@/components/brand/renewlet-brand-mark";
import { useI18n } from "@/i18n/I18nProvider";

/**
 * 法务/声明类页面通用外壳（/terms、/privacy 等）。
 *
 * 目标：
 * - 登录页里会链接到这些页面，因此必须是“无需登录也可访问”
 * - 统一 UI：避免重复维护两套布局
 */
export function LegalPageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();

  return (
    <div className="auth-page theme-gradient">
      <div className="w-full max-w-2xl">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-card grid gap-6 sm:p-8">
          <RenewletBrandLockup
            title={title}
            subtitle={subtitle}
            textClassName="flex-1"
            titleClassName="text-xl"
          />

          <div className="text-sm text-muted-foreground leading-relaxed">
            {children}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button asChild variant="outline" className="border-border">
              <Link href="/login" className="inline-flex items-center gap-2">
                <ArrowLeft className="h-4 w-4" />
                {t("common.backToLogin")}
              </Link>
            </Button>
            <Button asChild variant="outline" className="border-border">
              <Link href="/" className="inline-flex items-center gap-2">
                <Home className="h-4 w-4" />
                {t("common.backHome")}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 全局 Providers（只在客户端运行）。
 *
 * 这里集中放：
 * - React Query：请求缓存/并发/重试
 * - 本地 ThemeProvider：主题切换（dark/light + 主题色）
 * - Toast/Tooltip：全局交互反馈
 * - AuthSync：保持本地认证会话与路由状态一致
 *
 * 私有配置与远端 settings 同步由私有路由壳挂载，公开入口不能静态依赖完整业务模型。
 */

import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/lib/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AuthSync } from "@/components/auth-sync";
import { AppearanceSync } from "@/components/appearance-sync";
import { ViewportHeightSync } from "@/components/viewport-height-sync";
import { I18nProvider } from "@/i18n/I18nProvider";

/** 应用级 Provider 组合（请将所有页面都包在里面）。 */
export default function Providers({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      {/* 路由同步组件只做客户端副作用，包在 Suspense 内保持渲染边界稳定。 */}
      <I18nProvider>
        <Suspense fallback={null}>
          <AuthSync />
        </Suspense>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <ViewportHeightSync />
          <AppearanceSync />
          <TooltipProvider>
            <Sonner />
            {children}
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

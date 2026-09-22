/**
 * SPA 路由表。
 *
 * 架构位置：只声明 URL 到页面组件的映射；页面组件按路由懒加载，
 * 受保护页面统一由 ProtectedRoute 延迟挂载，认证跳转、setup 可见性和缓存刷新继续由 AuthSync / 页面级 hook 处理。
 *
 * 注意： 新增公开页面时必须同步 `public-routes.ts`，否则刷新后会被客户端守卫带回登录页。
 */
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AppScrollRestoration } from "@/components/app-scroll-restoration";
import { ProtectedRoute } from "@/components/protected-route";
import {
  lazyPrivateAppShellLoader,
  lazyRouteLoader,
  routeFallbackForPathname,
} from "@/lib/route-resources";

const PrivateAppShell = lazy(lazyPrivateAppShellLoader);
const Dashboard = lazy(lazyRouteLoader("dashboard"));
const Subscriptions = lazy(lazyRouteLoader("subscriptions"));
const Calendar = lazy(lazyRouteLoader("calendar"));
const Statistics = lazy(lazyRouteLoader("statistics"));
const Settings = lazy(lazyRouteLoader("settings"));
const Setup = lazy(lazyRouteLoader("setup"));
const Login = lazy(lazyRouteLoader("login"));
const Privacy = lazy(lazyRouteLoader("privacy"));
const Terms = lazy(lazyRouteLoader("terms"));
const PublicStatus = lazy(lazyRouteLoader("publicStatus"));
const AdminUsers = lazy(lazyRouteLoader("adminUsers"));
const ForgotPassword = lazy(lazyRouteLoader("forgotPassword"));
const ResetPassword = lazy(lazyRouteLoader("resetPassword"));
const NotFound = lazy(lazyRouteLoader("notFound"));

function RouteFallback() {
  const { pathname } = useLocation();

  // 懒加载 fallback 与预热注册表共用路由事实源，避免新增页面时骨架和 chunk loader 分叉。
  return routeFallbackForPathname(pathname);
}

export default function App() {
  return (
    <>
      <AppScrollRestoration />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<ProtectedRoute><PrivateAppShell /></ProtectedRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="subscriptions" element={<Subscriptions />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="statistics" element={<Statistics />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin/users" element={<ProtectedRoute adminOnly><AdminUsers /></ProtectedRoute>} />
          </Route>
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/status/:token" element={<PublicStatus />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/index.html" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}

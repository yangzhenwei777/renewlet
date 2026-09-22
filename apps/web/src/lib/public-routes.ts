/**
 * 公共路由白名单（无需登录即可访问）。
 *
 * 为什么抽出来：
 * - 路由保护集中在 `src/components/auth-sync.tsx`，这里提供统一白名单。
 * - 白名单集中维护可以避免登录页里的条款/隐私链接无法访问。
 *
 * 约定：
 * - 这里仅判断“路径名”，不处理 query/hash
 * - API 路由不在此处处理，PocketBase/Go API 会自行返回 401/403。
 */

/** 判断某个 pathname 是否为“公开页面”。 */
export function isPublicRoutePath(pathname: string): boolean {
  // 认证/初始化页面必须公开，否则首次部署和会话过期无法恢复。
  if (
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname === "/setup"
  ) {
    return true;
  }

  // 登录页会链接法务页面，未登录用户也需要可读。
  if (pathname === "/terms" || pathname === "/privacy") {
    return true;
  }

  // public/docs/* 会映射到 /docs/*，用于公开部署文档。
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return true;
  }

  // 公开展示页靠高熵 token 隔离，未登录访问不能被 auth 守卫重定向。
  if (pathname.startsWith("/status/")) {
    return true;
  }

  return false;
}

export type RenewletRuntime = "pocketbase" | "cloudflare";

const configuredRuntime: unknown = import.meta.env["VITE_RENEWLET_RUNTIME"];

/**
 * 前端运行面开关。
 *
 * 默认仍是 Docker/Go/PocketBase；只有 Cloudflare 构建显式注入变量时才切换运行面，
 * 让页面和 hooks 继续依赖 services 层，而不是在 UI 里散落运行面分支。
 */
export const renewletRuntime: RenewletRuntime = configuredRuntime === "cloudflare" ? "cloudflare" : "pocketbase";
export const isCloudflareRuntime = renewletRuntime === "cloudflare";

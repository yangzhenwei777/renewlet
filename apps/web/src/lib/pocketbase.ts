/**
 * SDK 单例与少量 PocketBase 能力适配层。
 *
 * 架构位置：产品 API 认证由 HttpOnly cookie session 承担；这个 `pb` 实例只保留
 * PocketBase SDK 的请求/cancel 行为和少量兼容能力，不再作为登录 token 来源。
 *
 * 注意： `autoCancellation(false)` 是为了让 React Query/并发上传自己管理竞态；
 * 打开 SDK 自动取消会让相同 collection 的并行请求互相中断。
 */
import PocketBase, { ClientResponseError, type RecordModel } from "pocketbase";
import { getProductCurrentUserId } from "@/services/product-session";

const configuredBaseUrl: unknown = import.meta.env["VITE_POCKETBASE_URL"];
const baseUrl = typeof configuredBaseUrl === "string" && configuredBaseUrl
  ? configuredBaseUrl
  : window.location.origin;

export const pb = new PocketBase(baseUrl);
pb.autoCancellation(false);

export { ClientResponseError };
export type { RecordModel };

export function getCurrentUserId(): string | null {
  return getProductCurrentUserId();
}

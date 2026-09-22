/**
 * 账号邮箱读取 hook。
 *
 * 架构位置：
 * - Settings 页只展示登录邮箱，不允许通过 AppSettings 修改账号身份。
 * - 产品 session 的 user 视图是当前页面身份来源，避免把邮箱复制到业务设置后产生跨设备不一致。
 */
import { authClient } from "@/lib/auth-client";

export interface AccountIdentity {
  email: string | null;
  role: string;
  banned: boolean;
}

/** 从认证会话读取当前账号身份，pending 时 email 返回 null 以支持 UI 展示加载态。 */
export function useAccountIdentity(): AccountIdentity {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return { email: null, role: "user", banned: false };
  return {
    email: session?.user.email ?? "",
    role: session?.user.role ?? "user",
    banned: session?.user.banned ?? false,
  };
}

/** 从认证会话读取当前账号邮箱，pending 时返回 null 以支持 UI 展示加载态。 */
export function useAccountEmail(): string | null {
  return useAccountIdentity().email;
}

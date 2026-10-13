import PocketBase from "pocketbase";
import { getLocaleHeaders } from "@/i18n/api-locale";

// 密码重置保留PocketBase原生协议；SDK不能成为产品session或用户ID的来源。
const configuredBaseUrl: unknown = import.meta.env["VITE_POCKETBASE_URL"];
const client = new PocketBase(
  typeof configuredBaseUrl === "string" && configuredBaseUrl ? configuredBaseUrl : window.location.origin,
);
// 独立重置请求不能被SDK按同一路径相互取消；上层表单拥有提交状态。
client.autoCancellation(false);

export const passwordResetService = {
  async request(email: string): Promise<void> {
    // 等待SDK代码期间语言可能变化；只在发送时读取已提交语言。
    await client.collection("users").requestPasswordReset(email, { headers: getLocaleHeaders() });
  },
  async confirm(token: string, password: string): Promise<void> {
    await client.collection("users").confirmPasswordReset(token, password, password, { headers: getLocaleHeaders() });
  },
};

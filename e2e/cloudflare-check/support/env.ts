/// <reference types="node" />

export const cloudflareAuthStatePath = "test-results/cloudflare-check/.auth/admin.json";

export type CloudflareCheckEnv = {
  /** 被巡检的线上/预览 Worker 地址，必须是完整 URL。 */
  baseURL: string;
  /** readonly 模式可不提供账号；认证巡检会显式要求。 */
  credentials: { email: string; password: string } | null;
  /** temporary-write-delete 才允许创建后再删除临时订阅，readonly 只做非破坏性检查。 */
  writeScope: "temporary-write-delete" | "readonly";
};

function normalizeBaseURL(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error("Cloudflare 巡检需要设置 RENEWLET_E2E_BASE_URL。");
  }
  return new URL(value).toString().replace(/\/$/, "");
}

export function getCloudflareCheckEnv(): CloudflareCheckEnv {
  const email = process.env.RENEWLET_E2E_EMAIL?.trim() ?? "";
  const password = process.env.RENEWLET_E2E_PASSWORD?.trim() ?? "";
  const rawWriteScope = process.env.RENEWLET_E2E_WRITE_SCOPE?.trim();
  // 默认允许临时写入，是为了让维护者巡检覆盖 D1/R2 写路径；只读生产账号需显式声明 readonly。
  const writeScope = rawWriteScope === "readonly" ? "readonly" : "temporary-write-delete";

  return {
    baseURL: normalizeBaseURL(process.env.RENEWLET_E2E_BASE_URL),
    credentials: email && password ? { email, password } : null,
    writeScope,
  };
}

export function requireCloudflareCredentials(): { email: string; password: string } {
  const { credentials } = getCloudflareCheckEnv();
  if (!credentials) {
    throw new Error("认证巡检需要设置 RENEWLET_E2E_EMAIL 和 RENEWLET_E2E_PASSWORD。");
  }
  return credentials;
}

export function temporaryWritesEnabled(): boolean {
  return getCloudflareCheckEnv().writeScope === "temporary-write-delete";
}

import {
  authSecuritySettingsPayloadSchema,
  authSecuritySettingsUpdateBodySchema,
  authSecurityTurnstileTestBodySchema,
  authSecurityTurnstileTestPayloadSchema,
} from "@renewlet/shared/schemas/admin";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import { requireAdmin } from "./auth";
import {
  authSecurityResponseFromStored,
  readAuthSecuritySettings,
  saveAuthSecuritySettings,
  turnstileComplete,
  verifyTurnstileChallenge,
} from "./auth-security-store";
import type { Env } from "./types";

export async function readAuthSecurity(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  return successJson(authSecuritySettingsPayloadSchema.parse(authSecurityResponseFromStored(await readAuthSecuritySettings(env))));
}

export async function updateAuthSecurity(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  await requireAdmin(request, env);
  const body = await readJson(request, authSecuritySettingsUpdateBodySchema, locale);
  const current = await readAuthSecuritySettings(env);
  // shared schema 是 Docker/Worker/前端共同 wire-shape：secret 省略=保留，空字符串=清空，响应只回 secretConfigured。
  const next = {
    turnstileEnabled: body.turnstile.enabled,
    turnstileSiteKey: body.turnstile.siteKey.trim(),
    turnstileSecret: body.turnstile.secret === undefined ? current.turnstileSecret : body.turnstile.secret.trim(),
  };
  if (next.turnstileEnabled && !turnstileComplete(next)) {
    throw new HttpError(400, serverText(locale, "auth.turnstileConfigIncomplete"), "TURNSTILE_CONFIG_INCOMPLETE");
  }
  const saved = await saveAuthSecuritySettings(env, next);
  return successJson(authSecuritySettingsPayloadSchema.parse(authSecurityResponseFromStored(saved)));
}

export async function testAuthSecurityTurnstile(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  await requireAdmin(request, env);
  const body = await readJson(request, authSecurityTurnstileTestBodySchema, locale);
  const siteKey = body.turnstile.siteKey.trim();
  if (!siteKey) {
    throw new HttpError(400, serverText(locale, "auth.turnstileConfigIncomplete"), "TURNSTILE_CONFIG_INCOMPLETE");
  }
  let secret = body.turnstile.secret?.trim() ?? "";
  if (!secret) {
    // 空 secret 在测试接口里表示沿用服务端已保存密钥，不触发清空，也不要求前端读取真实 secret。
    secret = (await readAuthSecuritySettings(env)).turnstileSecret;
  }
  if (!secret) {
    throw new HttpError(400, serverText(locale, "auth.turnstileConfigIncomplete"), "TURNSTILE_CONFIG_INCOMPLETE");
  }
  const token = body.turnstile.turnstileToken.trim();
  if (!token) {
    throw new HttpError(400, serverText(locale, "auth.turnstileRequired"), "TURNSTILE_REQUIRED");
  }
  // 配置页测试只消费草稿 token 和候选 secret，不写 D1；成功后仍由管理员显式保存/启用。
  if (!await verifyTurnstileChallenge(request, secret, token)) {
    // Siteverify 原始响应和网络错误只转成稳定测试错误码，避免把 secret/token/Cloudflare 细节带回浏览器。
    throw new HttpError(400, serverText(locale, "auth.turnstileTestFailed"), "TURNSTILE_TEST_FAILED");
  }
  return successJson(authSecurityTurnstileTestPayloadSchema.parse({ verified: true }));
}

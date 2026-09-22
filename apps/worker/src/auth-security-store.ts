import { turnstilePublicConfigSchema } from "@renewlet/shared/schemas/app";
import { boolToInt, intToBool, nowIso } from "./db";
import { HttpError, type AppLocale } from "./http";
import { serverText } from "./server-i18n";
import type { AuthSecuritySettingsRow, Env } from "./types";
import { sendUpstreamRequest } from "./upstream-http";

const AUTH_SECURITY_KEY = "global";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_VERIFY_TIMEOUT_MS = 5000;
const TURNSTILE_RESPONSE_MAX_CHARS = 32 * 1024;

export interface AuthSecurityStoredSettings {
  // D1 只保存 key=global 的站点级访问安全策略，不能挂到用户 settings 或备份导出链路。
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
  turnstileSecret: string;
}

interface TurnstileSiteverifyResponse {
  success?: unknown;
}

type AuthSecuritySchemaState = {
  promise: Promise<void>;
};

let authSecuritySchemaByDb = new WeakMap<D1Database, AuthSecuritySchemaState>();

export function authSecurityResponseFromStored(settings: AuthSecurityStoredSettings) {
  return {
    turnstile: {
      enabled: settings.turnstileEnabled,
      siteKey: settings.turnstileSiteKey,
      secretConfigured: settings.turnstileSecret.length > 0,
    },
  };
}

export async function publicTurnstileConfig(env: Env) {
  const settings = await readAuthSecuritySettings(env);
  if (!turnstileComplete(settings)) {
    return turnstilePublicConfigSchema.parse({ enabled: false, siteKey: "" });
  }
  // 认证前 status 只能公开浏览器渲染 widget 所需的 siteKey；secretConfigured 属于管理员配置面。
  return turnstilePublicConfigSchema.parse({ enabled: true, siteKey: settings.turnstileSiteKey });
}

export async function readAuthSecuritySettings(env: Env): Promise<AuthSecurityStoredSettings> {
  let row: AuthSecuritySettingsRow | null;
  try {
    row = await env.DB.prepare(`
      SELECT key, turnstile_enabled, turnstile_site_key, turnstile_secret, created_at, updated_at
      FROM auth_security_settings
      WHERE key = ?
      LIMIT 1
    `).bind(AUTH_SECURITY_KEY).first<AuthSecuritySettingsRow>();
  } catch (error) {
    if (!isMissingAuthSecurityTable(error)) throw error;
    // status 是认证前热入口；旧 D1 尚未跑 migration 时先降级为未启用，避免升级窗口把登录页打成 500。
    return { turnstileEnabled: false, turnstileSiteKey: "", turnstileSecret: "" };
  }
  if (!row) {
    return { turnstileEnabled: false, turnstileSiteKey: "", turnstileSecret: "" };
  }
  return {
    turnstileEnabled: intToBool(row.turnstile_enabled),
    turnstileSiteKey: row.turnstile_site_key.trim(),
    turnstileSecret: row.turnstile_secret.trim(),
  };
}

export async function saveAuthSecuritySettings(env: Env, settings: AuthSecurityStoredSettings): Promise<AuthSecurityStoredSettings> {
  const normalized = {
    turnstileEnabled: settings.turnstileEnabled,
    turnstileSiteKey: settings.turnstileSiteKey.trim(),
    turnstileSecret: settings.turnstileSecret.trim(),
  };
  // 管理员保存才允许懒补表；认证前 status/read 只降级未启用，避免普通登录页触发 D1 DDL。
  await withAuthSecuritySchema(env, async () => {
    const timestamp = nowIso();
    await env.DB.prepare(`
      INSERT INTO auth_security_settings (key, turnstile_enabled, turnstile_site_key, turnstile_secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        turnstile_enabled = excluded.turnstile_enabled,
        turnstile_site_key = excluded.turnstile_site_key,
        turnstile_secret = excluded.turnstile_secret,
        updated_at = excluded.updated_at
    `).bind(
      AUTH_SECURITY_KEY,
      boolToInt(normalized.turnstileEnabled),
      normalized.turnstileSiteKey,
      normalized.turnstileSecret,
      timestamp,
      timestamp,
    ).run();
  });
  return normalized;
}

export async function requireTurnstileForPasswordLogin(request: Request, env: Env, token: string | undefined, locale: AppLocale): Promise<void> {
  const settings = await readAuthSecuritySettings(env);
  if (!turnstileComplete(settings)) return;
  const responseToken = token?.trim() ?? "";
  if (!responseToken) {
    throw new HttpError(400, serverText(locale, "auth.turnstileRequired"), "TURNSTILE_REQUIRED");
  }
  // Turnstile 必须在密码哈希校验前完成，避免爆破请求把成本推到用户查询和 password verify 热路径。
  const verified = await verifyTurnstileChallenge(request, settings.turnstileSecret, responseToken);
  if (!verified) {
    // Siteverify 网络失败和挑战失败都失败关闭；响应不透出 Cloudflare 原始错误，避免泄露配置和验证细节。
    throw new HttpError(400, serverText(locale, "auth.turnstileFailed"), "TURNSTILE_FAILED");
  }
}

export function turnstileComplete(settings: AuthSecurityStoredSettings): boolean {
  return settings.turnstileEnabled && settings.turnstileSiteKey.length > 0 && settings.turnstileSecret.length > 0;
}

export async function verifyTurnstileChallenge(request: Request, secret: string, token: string): Promise<boolean> {
  // 配置测试和登录校验必须共用同一条 Siteverify 出口，确保 secret/token 脱敏、timeout 和 remoteip 语义不漂移。
  return await verifyCloudflareTurnstileToken(secret, token, turnstileClientIP(request));
}

async function verifyCloudflareTurnstileToken(secret: string, token: string, remoteIP: string): Promise<boolean> {
  const body = new URLSearchParams({
    secret,
    response: token,
  });
  // remoteip 是 Siteverify 的辅助上下文，不是 Renewlet 授权依据；边缘拿不到可信地址时不阻塞验证请求。
  if (remoteIP) body.set("remoteip", remoteIP);
  try {
    // secret/token 交给统一 upstream helper 脱敏；Cloudflare 原始响应只转成布尔结果，不进入错误 envelope。
    const response = await sendUpstreamRequest(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }, {
      provider: "Cloudflare Turnstile",
      timeoutMs: TURNSTILE_VERIFY_TIMEOUT_MS,
      secrets: [secret, token],
    });
    if (!response.ok) return false;
    const text = await response.text();
    // Siteverify body 只服务本次判定；限长后解析失败统一 fail closed，避免第三方响应影响日志或持久状态。
    if (text.length > TURNSTILE_RESPONSE_MAX_CHARS) return false;
    const payload = JSON.parse(text) as TurnstileSiteverifyResponse;
    return payload.success === true;
  } catch {
    return false;
  }
}

async function withAuthSecuritySchema<T>(env: Env, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isMissingAuthSecurityTable(error)) throw error;
    await ensureAuthSecuritySchema(env);
    return await operation();
  }
}

async function ensureAuthSecuritySchema(env: Env): Promise<void> {
  const existing = authSecuritySchemaByDb.get(env.DB);
  if (existing) return await existing.promise;

  const state: AuthSecuritySchemaState = { promise: Promise.resolve() };
  state.promise = Promise.resolve().then(async () => {
    // 这里复刻 0033 migration 的单表形状；只在管理员保存配置遇到缺表时补建，不让 status 热路径触发 DDL。
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS auth_security_settings (
        key TEXT PRIMARY KEY CHECK (key = 'global'),
        turnstile_enabled INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_enabled IN (0, 1)),
        turnstile_site_key TEXT NOT NULL DEFAULT '',
        turnstile_secret TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run();
  }).catch((error: unknown) => {
    if (authSecuritySchemaByDb.get(env.DB) === state) authSecuritySchemaByDb.delete(env.DB);
    throw error;
  });
  authSecuritySchemaByDb.set(env.DB, state);
  return await state.promise;
}

function isMissingAuthSecurityTable(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*auth_security_settings/i.test(error.message);
}

function turnstileClientIP(request: Request): string {
  const candidates = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("true-client-ip"),
    request.headers.get("x-forwarded-for")?.split(",")[0],
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim() ?? "";
    if (/^[0-9A-Fa-f:.]{3,64}$/.test(value)) return value;
  }
  return "";
}

export function resetAuthSecuritySchemaForTest(): void {
  authSecuritySchemaByDb = new WeakMap<D1Database, AuthSecuritySchemaState>();
}

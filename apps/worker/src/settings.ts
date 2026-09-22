import { customConfigPayloadSchema } from "@renewlet/shared/schemas/custom-config";
import {
  appSettingsSecretStatus,
  applySettingsSecretUpdates,
  settingsPayloadSchema,
  settingsUpdateBodySchema,
  toPublicAppSettings,
  type ApiAppSettings,
} from "@renewlet/shared/schemas/settings";
import { mergeAppSettingsPatch } from "@renewlet/shared/settings-normalization";
import { ensureSettings, getCustomConfig, getTelegramBotBinding, putCustomConfig, settingsUpsertStatement } from "./db";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { requireAuth } from "./auth";
import { serverText } from "./server-i18n";
import { buildSubscriptionSchedulerRefreshStatements } from "./subscription-scheduler-state";
import { buildCostSharingCollectionReminderMirrorStatements } from "./subscriptions";
import type { Env } from "./types";

/**
 * readSettings 返回当前用户的公共设置与 secret configured 状态。
 *
 * Cloudflare 运行面按用户隔离 D1 setting 行；持久化 secret 只参与服务端合并，不能进入浏览器响应。
 */
export async function readSettings(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const settings = await ensureSettings(env, auth.user.id);
  return successJson(settingsResponse(settings));
}

/**
 * updateSettings 执行公共字段 PATCH 与 write-only secret mutation，并返回公共读取模型。
 *
 * Worker 必须复用 shared schema 作为事实来源，保证 Cloudflare/D1 与 Go/PocketBase 在字段默认值和内置图标来源上不漂移。
 */
export async function updateSettings(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const patch = await readJson(request, settingsUpdateBodySchema, locale);
  const current = await ensureSettings(env, auth.user.id);
  const { secretUpdates, ...publicPatch } = patch;
  // HTTP patch 不含 secret 字段；先合并公开配置，再在内存应用判别联合，最终统一过完整持久化 schema。
  const withPublicPatch = mergeAppSettingsPatch(current, publicPatch);
  const next = applySettingsSecretUpdates(withPublicPatch, secretUpdates);
  await rejectInstalledTelegramBotSettingsChange(env, auth.user.id, current, next, locale);
  const statements = [settingsUpsertStatement(env, auth.user.id, next)];
  if (costSharingScheduleSettingsChanged(current, next)) {
    statements.push(...await buildCostSharingCollectionReminderMirrorStatements(env, auth.user.id, next));
  }
  if (subscriptionScheduleSettingsChanged(current, next)) {
    statements.push(...await buildSubscriptionSchedulerRefreshStatements(env, auth.user.id, {
      resetAutoRenewCheck: false,
      settings: next,
    }));
  }
  // settings、受全局规则影响的镜像和 scheduler schedule 必须同批提交，失败时浏览器仍看到旧配置。
  await env.DB.batch(statements);
  return successJson(settingsResponse(next));
}

function subscriptionScheduleSettingsChanged(before: ApiAppSettings, after: ApiAppSettings): boolean {
  return before.notificationTimeLocal !== after.notificationTimeLocal
    || costSharingScheduleSettingsChanged(before, after);
}

function costSharingScheduleSettingsChanged(before: ApiAppSettings, after: ApiAppSettings): boolean {
  return before.timezone !== after.timezone
    || before.notificationReminderDays !== after.notificationReminderDays;
}

function settingsResponse(settings: ApiAppSettings) {
  return settingsPayloadSchema.parse({
    settings: toPublicAppSettings(settings),
    secretStatus: appSettingsSecretStatus(settings),
  });
}

/**
 * readCustomConfig 读取当前用户的自定义配置。
 *
 * 自定义配置允许用户持久化标签/分类等业务文本，因此只做形状校验与用户隔离，不把内容转成产品内置文案。
 */
export async function readCustomConfig(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const config = await getCustomConfig(env, auth.user.id);
  return successJson(customConfigPayloadSchema.parse({ config }));
}

/**
 * updateCustomConfig 写入当前用户的自定义配置。
 *
 * 请求体和响应都通过同一个 shared schema，避免 Cloudflare 版接受 Docker 版不会保存的数据形状。
 */
export async function updateCustomConfig(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, customConfigPayloadSchema, locale);
  const config = await putCustomConfig(env, auth.user.id, body.config);
  return successJson(customConfigPayloadSchema.parse({ config }));
}

async function rejectInstalledTelegramBotSettingsChange(
  env: Env,
  userId: string,
  current: Awaited<ReturnType<typeof ensureSettings>>,
  next: Awaited<ReturnType<typeof ensureSettings>>,
  locale: ReturnType<typeof requestLocale>,
): Promise<void> {
  if (current.telegramBotToken.trim() === next.telegramBotToken.trim() && current.telegramChatId.trim() === next.telegramChatId.trim()) return;
  const binding = await getTelegramBotBinding(env, userId);
  if (!binding || binding.status !== "installed") return;
  // 已安装命令时 Telegram 远端仍持有 webhook；必须先删除命令，才能改 Bot Token 或 Chat ID。
  throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "TELEGRAM_BOT_COMMANDS_INSTALLED");
}

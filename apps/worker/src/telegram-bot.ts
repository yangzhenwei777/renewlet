import { telegramBotCommandsPayloadSchema } from "@renewlet/shared/schemas/telegram-bot";
import type { PublicApiDueItem } from "@renewlet/shared/schemas/public-api";
import { requireAuth } from "./auth";
import { getSettings, getTelegramBotBinding, newId, nowIso, TELEGRAM_BOT_BINDING_COLUMNS } from "./db";
import { randomToken, sha256 } from "./crypto";
import { HttpError, json, requireEmptyBody, requestLocale, successJson } from "./http";
import { requestOrigin } from "./request-origin";
import { accountContentLocale, serverFormat, serverText, type AppLocale } from "./server-i18n";
import {
  upstreamErrorDetailsFromError,
} from "./upstream-response";
import { requireUpstreamHttpOk, sendUpstreamJson } from "./upstream-http";
import {
  readPublicApiDueForUser,
  readPublicApiNextDueForUser,
  readPublicApiStatusForUser,
  readPublicApiSubscriptionsForUser,
} from "./public-api";
import { dateOnlyInZone } from "./subscription-renewal";
import { telegramBotMessage } from "./telegram-format";
import type { ApiAppSettings, Env, TelegramBotBindingRow } from "./types";

const TELEGRAM_WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const TELEGRAM_UPDATE_BODY_LIMIT = 1 << 20;
const TELEGRAM_DUE_DEFAULT_DAYS = 30;
const TELEGRAM_DUE_MAX_DAYS = 366;
const TELEGRAM_COMMAND_LIST_LIMIT = 10;

type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramUpdate = {
  updateId: number | null;
  chatId: string | null;
  text: string;
};

export async function readTelegramBotCommands(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const settings = await getSettings(env, auth.user.id);
  const binding = await getTelegramBotBinding(env, auth.user.id);
  const bindingMatches = binding ? await bindingMatchesSettings(binding, settings) : false;
  return noStoreSuccessJson(telegramBotCommandsDto(settings, binding, bindingMatches));
}

export async function installTelegramBotCommands(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await requireEmptyBody(request, locale);
  const origin = requestOrigin(request);
  if (new URL(origin).protocol !== "https:") {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "TELEGRAM_BOT_HTTPS_REQUIRED");
  }
  const settings = await getSettings(env, auth.user.id);
  const config = telegramSavedConfig(settings);
  if (!config) throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "TELEGRAM_BOT_CONFIG_INCOMPLETE");
  const existing = await getTelegramBotBinding(env, auth.user.id);
  if (existing?.status === "installed" && !await bindingMatchesSettings(existing, settings)) {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "TELEGRAM_BOT_INSTALLED_SETTINGS_LOCKED");
  }

  const timestamp = nowIso();
  const bindingId = existing?.id ?? newId("tgb");
  const secret = randomToken(32);
  const row: TelegramBotBindingRow = {
    id: bindingId,
    user_id: auth.user.id,
    chat_id: config.chatId,
    bot_token_hash: await sha256(config.botToken),
    webhook_secret_hash: await sha256(secret),
    status: "installing",
    last_update_id: 0,
    last_used_at: null,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
  };
  // installing 行先落库，确保 setWebhook 指向的 bindingId 已存在；失败路径会删除本地行并清理远端状态。
  await env.DB.prepare(`
    INSERT INTO telegram_bot_bindings (
      id, user_id, chat_id, bot_token_hash, webhook_secret_hash, status,
      last_update_id, last_used_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      id = excluded.id,
      chat_id = excluded.chat_id,
      bot_token_hash = excluded.bot_token_hash,
      webhook_secret_hash = excluded.webhook_secret_hash,
      status = excluded.status,
      last_update_id = excluded.last_update_id,
      last_used_at = NULL,
      updated_at = excluded.updated_at
  `).bind(
    row.id,
    row.user_id,
    row.chat_id,
    row.bot_token_hash,
    row.webhook_secret_hash,
    row.status,
    row.last_update_id,
    row.created_at,
    row.updated_at,
  ).run();

  try {
    // Telegram 菜单和后续 Bot 对话没有浏览器设备上下文，只能使用账号内容语言。
    await installTelegramRemote(config.botToken, config.chatId, `${origin}/api/telegram/webhook/${bindingId}`, secret, accountContentLocale(settings.localePreference));
    await env.DB.prepare("UPDATE telegram_bot_bindings SET status = 'installed', updated_at = ? WHERE user_id = ? AND id = ?")
      .bind(nowIso(), auth.user.id, bindingId)
      .run();
  } catch (error) {
    await bestEffortTelegramRemoteCleanup(config.botToken, config.chatId, locale);
    await env.DB.prepare("DELETE FROM telegram_bot_bindings WHERE user_id = ? AND id = ?").bind(auth.user.id, bindingId).run();
    throw telegramApiHttpError(error, locale);
  }

  return noStoreSuccessJson(telegramBotCommandsDto(settings, await getTelegramBotBinding(env, auth.user.id), true));
}

export async function deleteTelegramBotCommands(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await requireEmptyBody(request, locale);
  const binding = await getTelegramBotBinding(env, auth.user.id);
  if (!binding) throw new HttpError(404, serverText(locale, "common.notFound"), "NOT_FOUND");
  const settings = await getSettings(env, auth.user.id);
  const config = telegramSavedConfig(settings);
  if (!config) throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "TELEGRAM_BOT_CONFIG_INCOMPLETE");
  try {
    await deleteTelegramRemote(config.botToken, config.chatId, locale);
  } catch (error) {
    throw telegramApiHttpError(error, locale);
  }
  await env.DB.prepare("DELETE FROM telegram_bot_bindings WHERE user_id = ? AND id = ?").bind(auth.user.id, binding.id).run();
  return noStoreSuccessJson({});
}

export async function telegramWebhook(request: Request, env: Env, bindingId: string): Promise<Response> {
  const binding = await env.DB.prepare(`SELECT ${TELEGRAM_BOT_BINDING_COLUMNS} FROM telegram_bot_bindings WHERE id = ? LIMIT 1`)
    .bind(bindingId)
    .first<TelegramBotBindingRow>();
  if (!binding) throw new HttpError(404, serverText(requestLocale(request), "common.notFound"), "NOT_FOUND");
  if (!await webhookSecretMatches(binding, request.headers.get(TELEGRAM_WEBHOOK_SECRET_HEADER) ?? "")) {
    return noStoreJson({ ok: false }, { status: 401 });
  }
  if (binding.status !== "installed") return telegramWebhookOk();
  const update = await readTelegramUpdate(request);
  if (update.updateId === null) return telegramWebhookOk();
  if (update.updateId <= binding.last_update_id) return telegramWebhookOk();
  if (update.chatId !== binding.chat_id) {
    return telegramWebhookOk();
  }
  const parsed = parseTelegramCommand(update.text);
  if (!parsed) {
    return telegramWebhookOk();
  }
  // settings 读取放在真实命令之后；foreign chat/非命令 no-op 不产生额外 D1 读写，也不刷新 last_update_id。
  const settings = await getSettings(env, binding.user_id);
  if (!await bindingMatchesSettings(binding, settings)) return telegramWebhookOk();
  // Webhook 的 Accept-Language 来自 Telegram 基础设施，不能覆盖 owner 的账号偏好。
  const telegramLocale = accountContentLocale(settings.localePreference);
  const reply = await telegramCommandReply(env, binding.user_id, settings, parsed.command, parsed.arg, telegramLocale);
  const config = telegramSavedConfig(settings);
  if (config && reply) {
    // 命令已经处理完就推进 update；sendMessage 失败也不让 Telegram 重试造成重复查询和重复 D1 写入。
    await telegramSendMessage(config.botToken, binding.chat_id, reply, settings.telegramMessageFormat, telegramLocale).catch(() => undefined);
  }
  await markTelegramBindingUpdate(env, binding, update.updateId, true);
  return telegramWebhookOk();
}

function telegramBotCommandsDto(settings: ApiAppSettings, binding: TelegramBotBindingRow | null, bindingMatches: boolean) {
  const config = telegramSavedConfig(settings);
  let status: "not_configured" | "not_installed" | "installing" | "installed" = config ? "not_installed" : "not_configured";
  let installed = false;
  if (binding && bindingMatches) {
    status = binding.status;
    installed = binding.status === "installed";
  }
  if (!config) {
    status = "not_configured";
    installed = false;
  }
  return telegramBotCommandsPayloadSchema.parse({
    configComplete: Boolean(config),
    installed,
    status,
    chatId: config?.chatId ?? null,
    installedAt: binding && bindingMatches && binding.status === "installed" ? binding.created_at : null,
    lastUsedAt: binding && bindingMatches ? binding.last_used_at : null,
  });
}

function telegramSavedConfig(settings: ApiAppSettings): { botToken: string; chatId: string } | null {
  const botToken = settings.telegramBotToken.trim();
  const chatId = settings.telegramChatId.trim();
  return botToken && chatId ? { botToken, chatId } : null;
}

async function bindingMatchesSettings(binding: TelegramBotBindingRow, settings: ApiAppSettings): Promise<boolean> {
  const config = telegramSavedConfig(settings);
  if (!config) return false;
  return binding.chat_id === config.chatId && binding.bot_token_hash === await sha256(config.botToken);
}

async function webhookSecretMatches(binding: TelegramBotBindingRow, secret: string): Promise<boolean> {
  const trimmed = secret.trim();
  if (!trimmed) return false;
  return constantTimeEqual(await sha256(trimmed), binding.webhook_secret_hash);
}

async function installTelegramRemote(botToken: string, chatId: string, webhookUrl: string, secret: string, locale: AppLocale): Promise<void> {
  await telegramPostJson(botToken, "setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message"],
    drop_pending_updates: true,
    max_connections: 1,
    secret_token: secret,
  }, locale, [secret, chatId]);
  await telegramPostJson(botToken, "setMyCommands", {
    commands: telegramMenuCommands(locale),
    scope: { type: "chat", chat_id: chatId },
  }, locale, [chatId]);
}

async function deleteTelegramRemote(botToken: string, chatId: string, locale: AppLocale): Promise<void> {
  await telegramPostJson(botToken, "deleteWebhook", { drop_pending_updates: true }, locale, [chatId]);
  await telegramPostJson(botToken, "deleteMyCommands", { scope: { type: "chat", chat_id: chatId } }, locale, [chatId]);
}

async function bestEffortTelegramRemoteCleanup(botToken: string, chatId: string, locale: AppLocale): Promise<void> {
  await telegramPostJson(botToken, "deleteWebhook", { drop_pending_updates: true }, locale, [chatId]).catch(() => undefined);
  await telegramPostJson(botToken, "deleteMyCommands", { scope: { type: "chat", chat_id: chatId } }, locale, [chatId]).catch(() => undefined);
}

async function telegramSendMessage(botToken: string, chatId: string, text: string, format: ApiAppSettings["telegramMessageFormat"], locale: AppLocale): Promise<void> {
  const message = telegramBotMessage(text, format);
  await telegramPostJson(botToken, "sendMessage", {
    chat_id: chatId,
    ...message,
    link_preview_options: { is_disabled: true },
  }, locale, [chatId]);
}

async function telegramPostJson(botToken: string, method: string, payload: unknown, locale: AppLocale, secrets: readonly string[] = []): Promise<void> {
  const secretValues = [botToken, ...secrets];
  const response = await sendUpstreamJson(`https://api.telegram.org/bot${botToken}/${method}`, payload, {
    provider: "Telegram",
    secrets: secretValues,
  });
  await requireUpstreamHttpOk(response, { provider: "Telegram", secrets: secretValues });
  void locale;
}

function telegramApiHttpError(error: unknown, locale: AppLocale): HttpError {
  return new HttpError(502, serverText(locale, "common.internalError"), "TELEGRAM_API_FAILED", upstreamErrorDetailsFromError(error));
}

function telegramMenuCommands(locale: AppLocale): TelegramBotCommand[] {
  // BotCommand.description 是 Telegram 菜单纯文本契约；富文本只属于后续 sendMessage，/due 仅保留手输高级入口。
  return [
    { command: "start", description: serverText(locale, "telegramBot.menu.start") },
    { command: "help", description: serverText(locale, "telegramBot.menu.help") },
    { command: "status", description: serverText(locale, "telegramBot.menu.status") },
    { command: "next", description: serverText(locale, "telegramBot.menu.next") },
    { command: "today", description: serverText(locale, "telegramBot.menu.today") },
    { command: "week", description: serverText(locale, "telegramBot.menu.week") },
    { command: "month", description: serverText(locale, "telegramBot.menu.month") },
    { command: "subscriptions", description: serverText(locale, "telegramBot.menu.subscriptions") },
    { command: "settings", description: serverText(locale, "telegramBot.menu.settings") },
  ];
}

async function telegramCommandReply(env: Env, userId: string, settings: ApiAppSettings, command: string, arg: string, locale: AppLocale): Promise<string> {
  // 命令 adapter 只做路由和文本排版；订阅读取必须继续走 Public API owner-scoped service。
  switch (command) {
    case "start":
    case "help":
      return helpText(locale);
    case "status":
      return statusText(await readPublicApiStatusForUser(env, userId), locale);
    case "next":
      return nextText(await readPublicApiNextDueForUser(env, userId, { settings }), locale);
    case "today": {
      const today = dateOnlyInZone(new Date(), settings.timezone);
      const due = await readPublicApiDueForUser(env, userId, 1, { settings });
      return dueText({ ...due, items: due.items.filter((item) => item.dueDate === today) }, locale, serverText(locale, "telegramBot.due.todayTitle"));
    }
    case "week":
      return dueText(await readPublicApiDueForUser(env, userId, 7, { settings }), locale);
    case "month":
      return dueText(await readPublicApiDueForUser(env, userId, 30, { settings }), locale);
    case "due":
      return dueText(await readPublicApiDueForUser(env, userId, dueDays(arg), { settings }), locale);
    case "subscriptions":
      return subscriptionsText(await readPublicApiSubscriptionsForUser(env, userId, { limit: TELEGRAM_COMMAND_LIST_LIMIT, locale }), locale);
    case "settings":
      return settingsText(settings, locale);
    default:
      return helpText(locale);
  }
}

function helpText(locale: AppLocale): string {
  return [
    serverText(locale, "telegramBot.help.title"),
    serverText(locale, "telegramBot.help.status"),
    serverText(locale, "telegramBot.help.next"),
    serverText(locale, "telegramBot.help.today"),
    serverText(locale, "telegramBot.help.week"),
    serverText(locale, "telegramBot.help.month"),
    serverFormat(locale, "telegramBot.help.due", { days: TELEGRAM_DUE_DEFAULT_DAYS }),
    serverFormat(locale, "telegramBot.help.subscriptions", { limit: TELEGRAM_COMMAND_LIST_LIMIT }),
    serverText(locale, "telegramBot.help.settings"),
    serverText(locale, "telegramBot.help.help"),
  ].join("\n");
}

function statusText(response: Awaited<ReturnType<typeof readPublicApiStatusForUser>>, locale: AppLocale): string {
  return [
    serverText(locale, "telegramBot.status.title"),
    serverFormat(locale, "telegramBot.status.total", { count: response.total }),
    serverFormat(locale, "telegramBot.status.trial", { count: response.byStatus.trial }),
    serverFormat(locale, "telegramBot.status.active", { count: response.byStatus.active }),
    serverFormat(locale, "telegramBot.status.expired", { count: response.byStatus.expired }),
    serverFormat(locale, "telegramBot.status.paused", { count: response.byStatus.paused }),
    serverFormat(locale, "telegramBot.status.cancelled", { count: response.byStatus.cancelled }),
  ].join("\n");
}

function nextText(item: PublicApiDueItem | null, locale: AppLocale): string {
  const lines = [serverText(locale, "telegramBot.next.title")];
  if (!item) return [...lines, serverText(locale, "telegramBot.next.empty")].join("\n");
  return [...lines, serverFormat(locale, "telegramBot.next.item", {
    date: item.dueDate,
    name: telegramSubscriptionName(item.subscription, locale),
    type: telegramDueTypeText(item.dueType, locale),
  })].join("\n");
}

function dueText(
  response: Awaited<ReturnType<typeof readPublicApiDueForUser>>,
  locale: AppLocale,
  title = serverFormat(locale, "telegramBot.due.title", { days: response.days }),
): string {
  const items = [...response.items].sort((left, right) => (
    left.dueDate.localeCompare(right.dueDate)
    || telegramSubscriptionName(left.subscription, locale).localeCompare(telegramSubscriptionName(right.subscription, locale))
  ));
  const lines = [title];
  if (items.length === 0) return [...lines, serverText(locale, "telegramBot.due.empty")].join("\n");
  const visible = items.slice(0, TELEGRAM_COMMAND_LIST_LIMIT);
  for (const item of visible) {
    lines.push(serverFormat(locale, "telegramBot.due.item", {
      date: item.dueDate,
      name: telegramSubscriptionName(item.subscription, locale),
      type: telegramDueTypeText(item.dueType, locale),
    }));
  }
  if (items.length > visible.length) {
    lines.push(serverFormat(locale, "telegramBot.due.truncated", { count: items.length - visible.length }));
  }
  return lines.join("\n");
}

function subscriptionsText(response: Awaited<ReturnType<typeof readPublicApiSubscriptionsForUser>>, locale: AppLocale): string {
  const total = response.total ?? response.subscriptions.length;
  const lines = [serverFormat(locale, "telegramBot.subscriptions.title", { total })];
  if (response.subscriptions.length === 0) return [...lines, serverText(locale, "telegramBot.subscriptions.empty")].join("\n");
  for (const subscription of response.subscriptions) {
    lines.push(serverFormat(locale, "telegramBot.subscriptions.item", {
      name: telegramSubscriptionName(subscription, locale),
      status: telegramSubscriptionStatus(subscription, locale),
      date: telegramSubscriptionNextDate(subscription, locale),
    }));
  }
  if (total > response.subscriptions.length) {
    lines.push(serverFormat(locale, "telegramBot.subscriptions.truncated", { count: total - response.subscriptions.length }));
  }
  return lines.join("\n");
}

function settingsText(settings: ApiAppSettings, locale: AppLocale): string {
  const messageStyle = settings.telegramMessageFormat === "html"
    ? serverText(locale, "telegramBot.settings.messageStyle.html")
    : serverText(locale, "telegramBot.settings.messageStyle.plain");
  return [
    serverText(locale, "telegramBot.settings.title"),
    serverFormat(locale, "telegramBot.settings.chatId", {
      chatId: settings.telegramChatId.trim() || serverText(locale, "telegramBot.settings.notConfigured"),
    }),
    serverFormat(locale, "telegramBot.settings.messageStyle", { style: messageStyle }),
    serverText(locale, "telegramBot.settings.manage"),
  ].join("\n");
}

type TelegramApiSubscription = PublicApiDueItem["subscription"];

function telegramSubscriptionName(subscription: TelegramApiSubscription, locale: AppLocale): string {
  return subscription.name.trim() || serverText(locale, "telegramBot.subscription.unnamed");
}

function telegramSubscriptionStatus(subscription: TelegramApiSubscription, locale: AppLocale): string {
  switch (subscription.status) {
    case "trial":
      return serverText(locale, "telegramBot.subscriptionStatus.trial");
    case "active":
      return serverText(locale, "telegramBot.subscriptionStatus.active");
    case "expired":
      return serverText(locale, "telegramBot.subscriptionStatus.expired");
    case "paused":
      return serverText(locale, "telegramBot.subscriptionStatus.paused");
    case "cancelled":
      return serverText(locale, "telegramBot.subscriptionStatus.cancelled");
    default:
      return serverText(locale, "telegramBot.subscriptionStatus.unknown");
  }
}

function telegramSubscriptionNextDate(subscription: TelegramApiSubscription, locale: AppLocale): string {
  return subscription.nextBillingDate.trim() || serverText(locale, "telegramBot.subscription.unknown");
}

function telegramDueTypeText(dueType: PublicApiDueItem["dueType"], locale: AppLocale): string {
  switch (dueType) {
    case "renewal":
      return serverText(locale, "telegramBot.dueType.renewal");
    case "trial":
      return serverText(locale, "telegramBot.dueType.trial");
    case "expiry":
      return serverText(locale, "telegramBot.dueType.expiry");
    default:
      return serverText(locale, "telegramBot.subscription.unknown");
  }
}

function dueDays(arg: string): number {
  const trimmed = arg.trim();
  if (!/^\d+$/.test(trimmed)) return TELEGRAM_DUE_DEFAULT_DAYS;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1) return TELEGRAM_DUE_DEFAULT_DAYS;
  return Math.min(value, TELEGRAM_DUE_MAX_DAYS);
}

function parseTelegramCommand(text: string): { command: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const commandPart = parts[0]?.slice(1).split("@")[0]?.trim().toLowerCase() ?? "";
  if (!commandPart) return null;
  return { command: commandPart, arg: parts[1] ?? "" };
}

async function readTelegramUpdate(request: Request): Promise<TelegramUpdate> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > TELEGRAM_UPDATE_BODY_LIMIT) {
    throw new HttpError(413, "Telegram update body too large", "BODY_TOO_LARGE");
  }
  // Telegram Update 会随 Bot API 演进增加字段；这里只宽松读取命令所需三项，未知字段不能导致 webhook 拒绝。
  const parsed = JSON.parse(text) as unknown;
  const update = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  const rawMessage = update["message"];
  const message = typeof rawMessage === "object" && rawMessage !== null ? rawMessage as Record<string, unknown> : {};
  const rawChat = message["chat"];
  const chat = typeof rawChat === "object" && rawChat !== null ? rawChat as Record<string, unknown> : {};
  const rawUpdateId = update["update_id"];
  const updateId = typeof rawUpdateId === "number" && Number.isSafeInteger(rawUpdateId) ? rawUpdateId : null;
  const rawChatId = chat["id"];
  const chatId = typeof rawChatId === "number" && Number.isSafeInteger(rawChatId)
    ? String(rawChatId)
    : typeof rawChatId === "string"
      ? rawChatId.trim()
      : null;
  return {
    updateId,
    chatId,
    text: typeof message["text"] === "string" ? message["text"] : "",
  };
}

async function markTelegramBindingUpdate(env: Env, binding: TelegramBotBindingRow, updateId: number, used: boolean): Promise<void> {
  // 只有真实命令路径会调用这里；no-op update 不写 last_update_id，避免 foreign chat 抢占后续合法 update。
  await env.DB.prepare(`
    UPDATE telegram_bot_bindings
    SET last_update_id = ?, last_used_at = CASE WHEN ? THEN ? ELSE last_used_at END, updated_at = ?
    WHERE id = ?
  `).bind(updateId, used ? 1 : 0, nowIso(), nowIso(), binding.id).run();
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function noStoreJson(value: unknown, init: ResponseInit = {}): Response {
  const response = json(value, init);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function noStoreSuccessJson(value: unknown, init: ResponseInit = {}): Response {
  const response = successJson(value, init);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function telegramWebhookOk(): Response {
  const response = json({ ok: true });
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";

type TelegramMessageFormat = ApiAppSettings["telegramMessageFormat"];

interface TelegramFormattedMessage {
  text: string;
  parse_mode?: "HTML";
}

// Telegram 富文本只能在这个 formatter 里产生；调用方继续传纯文本，避免各发送入口重复转义或漏转义。
export function telegramNotificationMessage(message: NotificationEmailMessage, format: TelegramMessageFormat): TelegramFormattedMessage {
  if (format !== "html") return { text: plainNotificationMessage(message) };
  return {
    text: [
      `<b>${escapeTelegramHtml(message.title)}</b>`,
      "",
      escapeTelegramHtml(message.content),
      "",
      `<i>${escapeTelegramHtml(message.timestamp)}</i>`,
    ].join("\n"),
    parse_mode: "HTML",
  };
}

export function telegramBotMessage(text: string, format: TelegramMessageFormat): TelegramFormattedMessage {
  if (format !== "html") return { text };
  // Bot 回复先保持纯文本行模型；HTML 模式只强调固定结构，不能让订阅名或外部输入决定标签边界。
  const lines = text.split("\n");
  const htmlLines = lines.map((line, index) => {
    const escaped = escapeTelegramHtml(line);
    if (index === 0 && escaped.trim()) return `<b>${escaped}</b>`;
    const countLine = escaped.match(/^(.+?)(: |：)(\d+)$/u);
    return countLine ? `${countLine[1]}${countLine[2]}<b>${countLine[3]}</b>` : escaped;
  });
  return { text: htmlLines.join("\n"), parse_mode: "HTML" };
}

export function plainNotificationMessage(message: NotificationEmailMessage): string {
  return `${message.title}\n\n${message.content}\n\n${message.timestamp}`;
}

function escapeTelegramHtml(value: string): string {
  // Telegram HTML parse_mode 只允许模板内的固定标签；订阅名、通知正文等用户内容必须先转义再拼接。
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

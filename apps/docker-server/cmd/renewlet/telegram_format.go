package main

import (
	"html"
	"strings"
)

type telegramFormattedMessage struct {
	Text      string
	ParseMode string
}

func formatTelegramNotificationMessage(message notificationMessage, format string) telegramFormattedMessage {
	// Telegram 富文本只能在这个 formatter 里产生；调用方继续传纯文本，避免各发送入口重复转义或漏转义。
	if format != telegramMessageFormatHTML {
		return telegramFormattedMessage{Text: buildTextMessage(message)}
	}
	return telegramFormattedMessage{
		Text: strings.Join([]string{
			"<b>" + escapeTelegramHTML(message.Title) + "</b>",
			"",
			escapeTelegramHTML(message.Content),
			"",
			"<i>" + escapeTelegramHTML(message.Timestamp) + "</i>",
		}, "\n"),
		ParseMode: "HTML",
	}
}

func formatTelegramBotMessage(text string, format string) telegramFormattedMessage {
	if format != telegramMessageFormatHTML {
		return telegramFormattedMessage{Text: text}
	}
	// Bot 回复先保持纯文本行模型；HTML 模式只强调固定结构，不能让订阅名或外部输入决定标签边界。
	lines := strings.Split(text, "\n")
	for index, line := range lines {
		escaped := escapeTelegramHTML(line)
		if index == 0 && strings.TrimSpace(escaped) != "" {
			lines[index] = "<b>" + escaped + "</b>"
			continue
		}
		if label, separator, value, ok := telegramCountLineParts(escaped); ok && isTelegramCountLine(label, value) {
			lines[index] = label + separator + "<b>" + strings.TrimSpace(value) + "</b>"
			continue
		}
		lines[index] = escaped
	}
	return telegramFormattedMessage{Text: strings.Join(lines, "\n"), ParseMode: "HTML"}
}

func escapeTelegramHTML(value string) string {
	// Telegram HTML parse_mode 只允许模板内的固定标签；订阅名、通知正文等用户内容必须先转义再拼接。
	return html.EscapeString(value)
}

func isTelegramCountLine(label string, value string) bool {
	if strings.TrimSpace(label) == "" || strings.TrimSpace(value) == "" {
		return false
	}
	for _, char := range strings.TrimSpace(value) {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func telegramCountLineParts(line string) (string, string, string, bool) {
	if label, value, ok := strings.Cut(line, ": "); ok {
		return label, ": ", value, true
	}
	if label, value, ok := strings.Cut(line, "："); ok {
		return label, "：", value, true
	}
	return "", "", "", false
}

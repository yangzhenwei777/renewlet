package main

import (
	"strings"
	"testing"
)

func TestTelegramFormatterDefaultsToPlainText(t *testing.T) {
	message := notificationMessage{
		Title:     "Renewlet & Friends",
		Content:   "A&B <Plan>",
		Timestamp: "2026-06-20 08:00:00 UTC",
	}

	formatted := formatTelegramNotificationMessage(message, telegramMessageFormatPlain)

	if formatted.ParseMode != "" {
		t.Fatalf("plain notification must not set parse mode, got %q", formatted.ParseMode)
	}
	if formatted.Text != buildTextMessage(message) {
		t.Fatalf("plain notification text drifted: %q", formatted.Text)
	}
}

func TestTelegramFormatterEscapesHTMLMode(t *testing.T) {
	notification := formatTelegramNotificationMessage(notificationMessage{
		Title:     `Renewlet & <Friends>`,
		Content:   `A&B <Plan> "Quote"`,
		Timestamp: "2026-06-20 08:00:00 UTC",
	}, telegramMessageFormatHTML)
	if notification.ParseMode != "HTML" {
		t.Fatalf("expected HTML parse mode, got %#v", notification)
	}
	if !strings.Contains(notification.Text, `<b>Renewlet &amp; &lt;Friends&gt;</b>`) || strings.Contains(notification.Text, "<Friends>") {
		t.Fatalf("notification html was not escaped: %q", notification.Text)
	}

	bot := formatTelegramBotMessage("Renewlet status\nTotal: 12\n总数：12\nA&B <Pro>", telegramMessageFormatHTML)
	if bot.ParseMode != "HTML" {
		t.Fatalf("expected bot HTML parse mode, got %#v", bot)
	}
	if !strings.Contains(bot.Text, "<b>Renewlet status</b>") || !strings.Contains(bot.Text, "Total: <b>12</b>") || !strings.Contains(bot.Text, "总数：<b>12</b>") {
		t.Fatalf("bot html emphasis missing: %q", bot.Text)
	}
	if !strings.Contains(bot.Text, "A&amp;B &lt;Pro&gt;") || strings.Contains(bot.Text, "<Pro>") {
		t.Fatalf("bot html user content was not escaped: %q", bot.Text)
	}
}

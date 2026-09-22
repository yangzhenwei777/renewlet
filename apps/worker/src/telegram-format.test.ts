import { describe, expect, it } from "vitest";
import { plainNotificationMessage, telegramBotMessage, telegramNotificationMessage } from "./telegram-format";

describe("Telegram message formatter", () => {
  it("keeps plain text as the default notification shape", () => {
    const message = {
      title: "Renewlet & Friends",
      content: "A&B <Plan>",
      timestamp: "2026-06-20 08:00:00 UTC",
      items: [],
      hasPayload: true,
    };

    const formatted = telegramNotificationMessage(message, "plain");

    expect(formatted).toEqual({ text: plainNotificationMessage(message) });
  });

  it("escapes notification and bot content before applying HTML emphasis", () => {
    const notification = telegramNotificationMessage({
      title: "Renewlet & <Friends>",
      content: `A&B <Plan> "Quote"`,
      timestamp: "2026-06-20 08:00:00 UTC",
      items: [],
      hasPayload: true,
    }, "html");
    expect(notification).toMatchObject({ parse_mode: "HTML" });
    expect(notification.text).toContain("<b>Renewlet &amp; &lt;Friends&gt;</b>");
    expect(notification.text).toContain("A&amp;B &lt;Plan&gt; &quot;Quote&quot;");
    expect(notification.text).not.toContain("<Friends>");

    const bot = telegramBotMessage("Renewlet status\nTotal: 12\n总数：12\nA&B <Pro>", "html");
    expect(bot).toMatchObject({ parse_mode: "HTML" });
    expect(bot.text).toContain("<b>Renewlet status</b>");
    expect(bot.text).toContain("Total: <b>12</b>");
    expect(bot.text).toContain("总数：<b>12</b>");
    expect(bot.text).toContain("A&amp;B &lt;Pro&gt;");
    expect(bot.text).not.toContain("<Pro>");
  });
});

// 共享邮件模板测试保护 Go/Worker 共同语义，避免两种运行面邮件正文和主题分叉。
import { describe, expect, it } from "vitest";
import { EMAIL_MAX_HTML_BYTES, buildNotificationEmail, type NotificationEmailItem, type NotificationEmailMessage, type NotificationEmailSettings } from "./email-template";

function settings(overrides: Partial<NotificationEmailSettings> = {}): NotificationEmailSettings {
  return {
    themeVariant: "emerald",
    themeCustomColor: { h: 160, s: 84, l: 39 },
    ...overrides,
  };
}

describe("buildNotificationEmail", () => {
  it("renders zh-CN reminder groups with the modern light-only template", () => {
    const email = buildNotificationEmail(settings({ themeVariant: "ocean" }), {
      title: "Renewlet 订阅提醒",
      content: "即将续费：Renewlet",
      timestamp: "2026-05-14 08:00:00 Asia/Shanghai",
      hasPayload: true,
      items: [
        item("renewal", "Renewal", "18", "CNY", "2026-05-17", 3),
        item("expiry", "Fixed Term", "30", "CNY", "2026-05-18", 4),
        item("trial", "Trial", "9.9", "USD", "2026-05-15", 1),
        item("expired", "Expired", "12", "EUR", "2026-05-01", 7),
      ],
    }, { locale: "zh-CN", appUrl: "https://renewlet.example/app/" });

    expect(email.subject).toBe("Renewlet 订阅提醒");
    expect(email.text).toContain("即将续费：Renewlet");
    expect(email.html).toContain('<table role="presentation"');
    expect(email.html).toContain('width="600"');
    expect(email.html).toContain('class="email-container" width="600"');
    expect(email.html).toContain("style=\"width:100%; max-width:600px;");
    expect(email.html).toContain('<html lang="zh-CN">');
    expect(email.html).toContain("<title>Renewlet 订阅提醒</title>");
    expect(email.html).toContain('<meta name="color-scheme" content="light only">');
    expect(email.html).toContain('<meta name="supported-color-schemes" content="light">');
    expectEmailBrand(email.html);
    expect(email.html).toContain("class=\"email-summary-panel\"");
    expect(email.html).toContain('class="email-summary-panel" style="width:100%; border-collapse:separate; border-spacing:0; background:#F8FAF9; border:1px solid #E6EAE8; border-radius:12px;"');
    expect(email.html).toContain("class=\"email-group-card\"");
    expect(email.html).toContain("今日提醒");
    expect(email.html).toContain("提醒项目");
    expect(email.html.match(/font-size:13px; line-height:20px;">你有 4 项订阅提醒需要查看。<\/div>/g)).toHaveLength(1);
    expect(email.html).toContain("即将续费");
    expect(email.html).toContain("即将到期");
    expect(email.html).toContain("到期日期");
    expect(email.html).toContain("到期日期 · 2026-05-18 · 提前 4 天提醒");
    expect(email.html).toContain("试用结束");
    expect(email.html).toContain("已过期");
    expect(email.html).toContain("18</p>");
    expect(email.html).toContain(">CNY</p>");
    expect(email.html).toContain('width="96"');
    expect(email.html).toContain('href="https://renewlet.example/app/subscriptions"');
    expect(email.html).toContain("#F5F7F6");
    expect(email.html).toContain("#FFFFFF");
    expect(email.html).toContain("#F8FAF9");
    expect(email.html).toContain("#E6EAE8");
    expect(email.html).toContain("#0F172A");
    expect(email.html).toContain("#64748B");
    expect(email.html).toContain("border-radius:20px");
    expect(email.html).toContain("border-radius:12px");
    expect(email.html).toContain(".email-outer-pad { padding:28px 0 !important; }");
    expect(email.html).toContain(".email-main-card { border-left:0 !important; border-right:0 !important; border-radius:0 !important; }");
    expect(email.html).toContain("class=\"email-main-card\"");
    expect(email.html).toContain("line-height:48px");
    expect(email.html).not.toContain('<h1 class="email-h1"');
    expect(email.html).not.toContain('class="email-px email-muted"');
    expect(email.html.match(/Renewlet 订阅提醒/g)).toHaveLength(1);
    expect(email.html).not.toContain("class=\"email-message-panel\"");
    expect(email.html).not.toContain("class=\"email-stack\"");
    expect(email.html).not.toContain("class=\"email-amount\"");
    expect(email.html).not.toContain("padding:4px 8px; border-radius:6px;");
    expect(email.html).not.toContain("padding-bottom:36px");
    expect(email.html).not.toContain("email-card-bottom-safe-area");
    expect(email.html).not.toContain('class="email-container email-card email-ledger"');
    expect(email.html).not.toContain("email-ledger");
    expect(email.html).not.toContain("light dark");
    expect(email.html).not.toContain("@media (prefers-color-scheme: dark)");
    expect(email.html).not.toContain("#0C0E12");
    expect(email.html).not.toContain("#13161B");
    expect(email.html).not.toContain("#23272E");
    expect(email.html).not.toContain("#1F2229");
    expect(email.html).not.toContain("display:flex");
    expect(email.html).not.toContain("display: flex");
    expect(email.html).not.toContain("display:grid");
    expect(email.html).not.toContain("display: grid");
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<svg");
    expect(email.html).not.toContain("background-image");
    expect(email.html).not.toContain("logo.svg");
    expect(email.html).not.toContain("cid:");
  });

  it("renders long reminder lists as compact ledger rows without item badges", () => {
    const items = Array.from({ length: 43 }, (_, index) => item("renewal", `Ledger Subscription ${index + 1}`, String(index + 1), "CNY", "2026-05-17", 3));
    const email = buildNotificationEmail(settings(), {
      title: "Renewlet 订阅提醒",
      content: "即将续费：Renewlet",
      timestamp: "2026-05-14 08:00:00 Asia/Shanghai",
      hasPayload: true,
      items,
    }, { locale: "zh-CN" });

    expect(new TextEncoder().encode(email.html).length).toBeLessThan(EMAIL_MAX_HTML_BYTES);
    expect(email.html.match(/Ledger Subscription/g)).toHaveLength(43);
    expect(email.html.match(/font-size:13px; line-height:20px;">你有 43 项订阅提醒需要查看。<\/div>/g)).toHaveLength(1);
    expect(email.html).toContain("Ledger Subscription 43");
    expect(email.html).toContain("扣费日期 · 2026-05-17 · 提前 3 天提醒");
    expect(email.html).toContain(">43</p>");
    expect(email.html).toContain(">CNY</p>");
    expect(email.html).toContain('class="email-group-card"');
    expect(email.html).toContain('width="96"');
    expect(email.html).not.toContain('class="email-message-panel"');
    expect(email.html).not.toContain("内容较长");
    expect(email.html).not.toContain("class=\"email-stack\"");
    expect(email.html).not.toContain("class=\"email-amount\"");
    expect(email.html).not.toContain("padding:4px 8px; border-radius:6px;");
    expect(email.html).not.toContain("email-card-bottom-safe-area");
  });

  it("renders cost sharing collection reminders with member payload amounts", () => {
    const email = buildNotificationEmail(settings(), {
      title: "Renewlet 订阅提醒",
      content: "家庭共享收款：Family Plan",
      timestamp: "2026-05-14 08:00:00 Asia/Shanghai",
      hasPayload: true,
      items: [{
        ...item("costSharing", "Family Plan", "30", "USD", "2026-05-17", 3),
        costSharing: {
          memberName: "Partner",
          amount: "10",
          currency: "USD",
        },
      }],
    }, { locale: "zh-CN" });

    expect(email.text).toContain("家庭共享收款");
    expect(email.html).toContain("家庭共享收款");
    expect(email.html).toContain("收款日期 · 2026-05-17 · 向 Partner 收款，提前 3 天提醒");
    expect(email.html).toContain(">10</p>");
    expect(email.html).toContain(">USD</p>");
  });

  it("renders en-US test notifications and settings CTA", () => {
    const email = buildNotificationEmail(settings(), {
      title: "Renewlet test notification",
      content: "If you received this message, the channel is ready.",
      timestamp: "2026-05-14 08:00:00 UTC",
      hasPayload: true,
      items: [],
    }, { locale: "en-US", appUrl: "https://renewlet.example" });

    expect(email.html).toContain('<html lang="en-US">');
    expect(email.html).toContain("<title>Renewlet test notification</title>");
    expect(email.html).toContain("Channel check");
    expect(email.html).toContain("If you received this message");
    expect(email.html).toContain("Generated at");
    expect(email.html).toContain('href="https://renewlet.example/settings"');
    expectEmailBrand(email.html);
    expect(email.html).not.toContain('<h1 class="email-h1"');
    expect(email.html).not.toContain("class=\"email-message-panel\"");
    expect(email.html).not.toContain("class=\"email-group-card\"");
    expect(email.html).not.toContain("padding-bottom:36px");
    expect(email.html).not.toContain("email-card-bottom-safe-area");
    expect(email.html).not.toContain("email-ledger");
  });

  it("keeps card bottom spacing without rendering placeholder content when CTA is unavailable", () => {
    const reminder = buildNotificationEmail(settings(), {
      title: "Renewlet 订阅提醒",
      content: "即将续费：Renewlet",
      timestamp: "2026-05-14 08:00:00 Asia/Shanghai",
      hasPayload: true,
      items: [item("renewal", "Renewal", "18", "CNY", "2026-05-17", 3)],
    }, { locale: "zh-CN" });
    const testStatus = buildNotificationEmail(settings(), testMessage(), { locale: "zh-CN" });
    const empty = buildNotificationEmail(settings(), {
      title: "Renewlet subscription reminder",
      content: "No subscriptions need reminders today.",
      timestamp: "2026-05-14 08:00:00 UTC",
      hasPayload: false,
      items: [],
    }, { locale: "en-US" });

    for (const html of [reminder.html, testStatus.html, empty.html]) {
      expect(html).toContain("padding-bottom:36px");
      expect(html).not.toContain("email-card-bottom-safe-area");
    }
  });

  it("keeps the message panel for empty reminder notifications", () => {
    const email = buildNotificationEmail(settings(), {
      title: "Renewlet subscription reminder",
      content: "No subscriptions need reminders today.",
      timestamp: "2026-05-14 08:00:00 UTC",
      hasPayload: false,
      items: [],
    }, { locale: "en-US" });

    expect(email.html).toContain("No reminders");
    expect(email.html).toContain("class=\"email-message-panel\"");
    expect(email.html).toContain("Message");
    expect(email.html).toContain("No subscriptions need reminders today.");
    expectEmailBrand(email.html);
    expect(email.html).not.toContain("class=\"email-group-card\"");
  });

  it("escapes user content and omits item logo urls", () => {
    const email = buildNotificationEmail(settings(), {
      title: '<script>alert("title")</script>',
      content: "Line <b>one</b>\nLine two",
      timestamp: "2026-05-14 08:00:00 Asia/Shanghai",
      hasPayload: true,
      items: [{
        ...item("renewal", "<img src=x onerror=alert(1)>", "8", "<USD>", "2026-05-17", 3),
        logoUrl: "https://cdn.example.com/private-logo.png",
      }],
    }, { locale: "zh-CN" });

    expect(email.html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.html).toContain("&lt;USD&gt;");
    expect(email.html).not.toContain("<script");
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("https://cdn.example.com/private-logo.png");
  });

  it("maps custom theme colors and renders light-only client css", () => {
    const email = buildNotificationEmail(settings({
      themeVariant: "custom",
      themeCustomColor: { h: 210, s: 90, l: 45 },
    }), testMessage(), { locale: "zh-CN", appUrl: "https://renewlet.example" });

    expect(email.html).toContain("#0B73DA");
    expect(email.html).toContain("color-scheme: light only");
    expect(email.html).not.toContain("@media (prefers-color-scheme: dark)");
    expect(email.html).not.toContain("light dark");
    expect(email.html).not.toContain("ZgotmplZ");
  });

  it("falls back to compact content when html would exceed the clipping guard", () => {
    // Worker 和 Go 共用同一体积预算；超长账单列表必须走 compact fallback，避免邮件客户端裁剪关键内容。
    const items = Array.from({ length: 800 }, (_, index) => item("renewal", `Very Long Subscription Name ${index}`, "18", "CNY", "2026-05-17", 3));
    const email = buildNotificationEmail(settings(), {
      title: "Renewlet 订阅提醒",
      content: "即将续费：Renewlet\n".repeat(2_000),
      timestamp: "2026-05-14 08:00:00 UTC",
      hasPayload: true,
      items,
    }, { locale: "zh-CN" });

    expect(new TextEncoder().encode(email.html).length).toBeLessThan(EMAIL_MAX_HTML_BYTES);
    expect(email.html).toContain("内容较长");
    expect(email.html).toContain("提醒项目");
    expect(email.html).toContain(">800</strong>");
    expect(email.html).toContain("class=\"email-message-panel\"");
    expect(email.html).toContain("padding-bottom:36px");
    expect(email.html).not.toContain("email-card-bottom-safe-area");
    expectEmailBrand(email.html);
    expect(email.html).not.toContain("class=\"email-group-card\"");
  });
});

function expectEmailBrand(html: string) {
  expect(html).toContain("class=\"email-brand-lockup\"");
  expect(html).toContain("class=\"email-brand-lockup-mark\"");
  expect(html).not.toContain("class=\"email-brand-mark\"");
  expect(html).toContain("Renewlet");
  expect(html).toContain("#111720");
  expect(html).toContain("#26313D");
  expect(html).toContain("#F8FAFC");
  expect(html).toContain("#10B981");
  expect(html).not.toContain(">R</td>");
  expect(html).not.toContain(">R</div>");
  expect(html).not.toContain("logo.svg");
  expect(html).not.toContain("cid:");
}

function testMessage(): NotificationEmailMessage {
  return {
    title: "Renewlet 测试通知",
    content: "如果你收到这条消息，说明通知渠道已经配置成功。",
    timestamp: "2026-05-14 08:00:00 UTC",
    hasPayload: true,
    items: [],
  };
}

function item(type: NotificationEmailItem["type"], name: string, price: string, currency: string, targetDate: string, reminderDays: number) {
  return {
    type,
    subscriptionId: type,
    name,
    price,
    currency,
    status: type === "trial" ? "trial" : "active",
    targetDate,
    reminderDays,
    daysUntil: reminderDays,
  };
}

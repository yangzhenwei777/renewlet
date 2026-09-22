import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LocalizedLabels } from "@/i18n/locales";
import { DEFAULT_SETTINGS, type AppSettings, type NotificationChannel } from "@/types/subscription";
import { NotificationChannelConfigPanel } from "./notification-channel-config-panel";
import { NotificationChannelList } from "./notification-channel-list";

const messages: Record<string, string> = {
  "common.configure": "配置",
  "common.disable": "停用",
  "common.disabled": "未启用",
  "common.enable": "启用",
  "common.enabled": "已启用",
  "common.close": "关闭",
  "settings.channel.discordReady": "Webhook URL 已填写",
  "settings.channel.discordTodo": "填写 Discord Webhook URL",
  "settings.channel.dingtalkReady": "钉钉机器人 Webhook URL 已填写",
  "settings.channel.dingtalkTodo": "填写钉钉机器人 Webhook URL",
  "settings.channel.pushplusReady": "Token 已填写",
  "settings.channel.pushplusTodo": "填写 PushPlus Token",
  "settings.channelConfig": "配置 {channel}",
  "settings.channelEnabledHelp": "该渠道已启用。",
  "settings.dingtalkKeyword": "自定义关键词（可选）",
  "settings.dingtalkKeywordHelp": "钉钉关键词校验要求关键词出现在消息正文中；如果填写 Test1 这类随机词，通知里也会显示它。建议使用 Renewlet、订阅提醒、续费这类自然关键词；隐藏式安全校验请使用加签。",
  "settings.dingtalkKeywordPlaceholder": "Renewlet",
  "settings.dingtalkSecret": "加签密钥（可选）",
  "settings.dingtalkSecretHelp": "填写后自动生成签名。",
  "settings.dingtalkTitleTemplate": "标题模板",
  "settings.dingtalkTitleTemplatePlaceholder": "例如：{brand} · {title}",
  "settings.dingtalkContentTemplate": "正文模板",
  "settings.dingtalkContentTemplatePlaceholder": "例如：{title}\n\n{content}\n\n{timestamp}",
  "settings.dingtalkTemplateHelp": "变量：{brand}、{keyword}、{title}、{content}、{timestamp}、{itemCount}。这里只改标题和正文，不是 JSON body 模板；Renewlet 仍会生成钉钉官方 payload。",
  "settings.dingtalkTemplateExamples": "模板示例",
  "settings.dingtalkTemplateExamplesOpen": "查看模板示例",
  "settings.dingtalkTemplateExamplesDescription": "选择一个示例后仍可继续编辑。",
  "settings.dingtalkTemplateExampleApplyNamed": "填入{name}模板",
  "settings.dingtalkTemplateExampleTitle": "标题",
  "settings.dingtalkTemplateExampleContent": "正文",
  "settings.dingtalkTemplateExampleDefault": "默认等价",
  "settings.dingtalkTemplateExampleDefaultTitle": "{title}",
  "settings.dingtalkTemplateExampleDefaultContent": "{title}\n\n{content}\n\n{timestamp}",
  "settings.dingtalkTemplateExampleKeyword": "关键词安全",
  "settings.dingtalkTemplateExampleKeywordTitle": "{brand} · {title}",
  "settings.dingtalkTemplateExampleKeywordContent": "{title}\n\n{content}\n\n{timestamp}\n\n{brand} · {keyword}",
  "settings.dingtalkTemplateExampleCount": "数量摘要",
  "settings.dingtalkTemplateExampleCountTitle": "{brand} · {itemCount} 项提醒",
  "settings.dingtalkTemplateExampleCountContent": "【{title}】\n\n{content}\n\n发送时间：{timestamp}",
  "settings.dingtalkWebhookHelp": "Renewlet 会按钉钉固定消息结构发送。",
  "settings.dingtalkWebhookUrl": "机器人 Webhook URL",
  "settings.discordBotAvatarUrl": "机器人头像 URL（可选）",
  "settings.discordBotUsername": "机器人用户名（可选）",
  "settings.discordWebhookHelp": "只支持 Discord 官方 Webhook URL，发送时会禁止提及。",
  "settings.discordWebhookUrl": "Webhook URL",
  "settings.help.dingtalk": "钉钉机器人安全设置",
  "settings.help.discord": "Discord 官方 Webhook 文档",
  "settings.help.pushplus": "PushPlus 消息接口文档",
  "settings.messageType": "消息类型",
  "settings.notificationChannels": "通知渠道",
  "settings.pushplusHelp": "从 PushPlus 获取的消息令牌或用户令牌。",
  "settings.pushplusToken": "PushPlus Token",
  "settings.testChannel.dingtalk": "测试 {channel} 通知",
  "settings.testChannel.discord": "测试 {channel} 通知",
  "settings.testChannel.pushplus": "测试 {channel} 通知",
  "settings.testing": "测试中",
  "settings.textMessage": "文本消息",
};

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`));
    },
    label: (labels: LocalizedLabels) => labels["zh-CN"] ?? labels["en-US"],
    formatDateTime: (value: string) => value,
  }),
}));

function StatefulPanel({
  channel,
  initialSettings,
  disabled = false,
  onTest = vi.fn(),
}: {
  channel: NotificationChannel;
  initialSettings?: Partial<AppSettings>;
  disabled?: boolean;
  onTest?: (channel: NotificationChannel) => void;
}) {
  const [settings, setSettings] = useState<AppSettings>({
    ...DEFAULT_SETTINGS,
    enabledChannels: [channel],
    ...initialSettings,
  });

  return (
    <NotificationChannelConfigPanel
      channel={channel}
      settings={settings}
      enabled
      updateSetting={(key, value) => setSettings((previous) => ({ ...previous, [key]: value }))}
      testingChannel={null}
      onTest={onTest}
      disabled={disabled}
    />
  );
}

describe("Discord and PushPlus notification settings", () => {
  it("renders and updates Discord fields with the existing compact panel style", async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    render(<StatefulPanel channel="discord" onTest={onTest} />);

    const panel = screen.getByRole("heading", { name: "配置 Discord" }).closest("div.rounded-lg");
    expect(panel).not.toBeNull();
    expect(panel as HTMLElement).toHaveClass("border");
    expect(panel as HTMLElement).toHaveClass("bg-secondary/30");
    expect(screen.getByRole("link", { name: "Discord 官方 Webhook 文档" })).toHaveAttribute(
      "href",
      "https://docs.discord.com/developers/resources/webhook",
    );

    await user.type(screen.getByLabelText("Webhook URL"), "https://discord.com/api/webhooks/123/token");
    await user.type(screen.getByLabelText("机器人用户名（可选）"), "Renewlet");
    await user.type(screen.getByLabelText("机器人头像 URL（可选）"), "https://cdn.example.com/avatar.png");

    expect(screen.getByLabelText("Webhook URL")).toHaveValue("https://discord.com/api/webhooks/123/token");
    expect(screen.getByLabelText("机器人用户名（可选）")).toHaveValue("Renewlet");
    expect(screen.getByLabelText("机器人头像 URL（可选）")).toHaveValue("https://cdn.example.com/avatar.png");
    const discordIdentityRow = screen.getByLabelText("机器人用户名（可选）").closest('[data-slot="form-field-row"]');
    expect(discordIdentityRow).toHaveAttribute("data-align-at", "sm");
    expect(discordIdentityRow).toHaveAttribute("data-tracks", "2");

    await user.click(screen.getByRole("button", { name: "测试 Discord 通知" }));
    expect(onTest).toHaveBeenCalledWith("discord");
  });

  it("renders DingTalk fields and keeps the Cloudflare IP caveat visible", async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    render(<StatefulPanel channel="dingtalk" onTest={onTest} />);

    expect(screen.getByRole("link", { name: "钉钉机器人安全设置" })).toHaveAttribute(
      "href",
      "https://dingtalk.apifox.cn/doc-3550006.md",
    );
    expect(screen.getByText("钉钉关键词校验要求关键词出现在消息正文中；如果填写 Test1 这类随机词，通知里也会显示它。建议使用 Renewlet、订阅提醒、续费这类自然关键词；隐藏式安全校验请使用加签。")).toBeInTheDocument();
    const templateExamplesTrigger = screen.getByRole("button", { name: "查看模板示例" });
    expect(templateExamplesTrigger).toHaveClass("h-8", "border", "border-border", "text-xs");
    expect(screen.queryByText("选择一个示例后仍可继续编辑。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "填入关键词安全模板" })).not.toBeInTheDocument();

    await user.click(templateExamplesTrigger);
    expect(screen.getByText("模板示例")).toBeInTheDocument();
    expect(screen.getByText("选择一个示例后仍可继续编辑。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "填入默认等价模板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "填入关键词安全模板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "填入数量摘要模板" })).toBeInTheDocument();
    expect(screen.getByText("{brand} · {title}")).toBeInTheDocument();
    expect(screen.getByText(/\{title\}\s+\{content\}\s+\{timestamp\}\s+\{brand\} · \{keyword\}/)).toBeInTheDocument();
    expect(screen.getByLabelText("标题模板")).toHaveValue("");
    expect(screen.getByLabelText("正文模板")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "填入关键词安全模板" }));
    expect(screen.getByLabelText("标题模板")).toHaveValue("{brand} · {title}");
    expect(screen.getByLabelText("正文模板")).toHaveValue("{title}\n\n{content}\n\n{timestamp}\n\n{brand} · {keyword}");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "填入关键词安全模板" })).not.toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("机器人 Webhook URL"), "https://oapi.dingtalk.com/robot/send?access_token=token");
    await user.clear(screen.getByLabelText("标题模板"));
    await user.clear(screen.getByLabelText("正文模板"));
    await user.type(screen.getByLabelText("标题模板"), "Renewlet title template");
    await user.type(screen.getByLabelText("正文模板"), "Renewlet body template");
    await user.type(screen.getByLabelText("自定义关键词（可选）"), "Renewlet");
    await user.type(screen.getByLabelText("加签密钥（可选）"), "SECsecret");

    expect(screen.getByLabelText("机器人 Webhook URL")).toHaveValue("https://oapi.dingtalk.com/robot/send?access_token=token");
    expect(screen.getByLabelText("标题模板")).toHaveValue("Renewlet title template");
    expect(screen.getByLabelText("正文模板")).toHaveValue("Renewlet body template");
    expect(screen.getByLabelText("自定义关键词（可选）")).toHaveValue("Renewlet");
    expect(screen.getByLabelText("加签密钥（可选）")).toHaveValue("SECsecret");
    const dingtalkTemplateRow = screen.getByLabelText("标题模板").closest('[data-slot="form-field-row"]');
    expect(dingtalkTemplateRow).toHaveAttribute("data-align-at", "sm");
    expect(dingtalkTemplateRow).toHaveAttribute("data-tracks", "2");

    await user.click(screen.getByRole("button", { name: "测试 钉钉机器人 通知" }));
    expect(onTest).toHaveBeenCalledWith("dingtalk");
  });

  it("renders PushPlus token field and keeps demo mode disabled", () => {
    render(<StatefulPanel channel="pushplus" initialSettings={{ pushplusToken: "push-token" }} disabled />);

    expect(screen.getByRole("link", { name: "PushPlus 消息接口文档" })).toHaveAttribute(
      "href",
      "https://www.pushplus.plus/doc/guide/api.html",
    );
    expect(screen.getByLabelText("PushPlus Token")).toHaveValue("push-token");
    expect(screen.getByLabelText("PushPlus Token")).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试 PushPlus 通知" })).toBeDisabled();
  });

  it("shows DingTalk, Discord and PushPlus summaries and disables channel toggles in demo mode", () => {
    render(
      <NotificationChannelList
        settings={{
          ...DEFAULT_SETTINGS,
          enabledChannels: ["discord"],
          dingtalkWebhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=token",
          discordWebhookUrl: "https://discord.com/api/webhooks/123/token",
          pushplusToken: "",
        }}
        activeChannel="discord"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByText("钉钉机器人 Webhook URL 已填写")).toBeInTheDocument();
    expect(screen.getByText("Webhook URL 已填写")).toBeInTheDocument();
    expect(screen.getByText("填写 PushPlus Token")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "启用 钉钉机器人" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "停用 Discord" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "启用 PushPlus" })).toBeDisabled();
  });
});

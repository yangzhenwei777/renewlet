/**
 * 通知渠道启用列表。
 *
 * 架构位置：负责展示渠道开关和配置完整性提示；是否可发送由 settings controller 与后端共同判定。
 *
 * 注意： 禁用渠道不等于删除配置，后续重新启用时应保留用户已填写的凭据。
 */
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages';
import { cn } from '@/lib/utils';
import { CHANNEL_LABELS, NOTIFICATION_CHANNELS, type AppSettings, type NotificationChannel } from '@/types/subscription';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

function getNotificationChannelSummary(settings: AppSettings, channel: NotificationChannel, t: Translate): string {
  switch (channel) {
    case 'telegram':
      return settings.telegramBotToken.trim() && settings.telegramChatId.trim()
        ? t("settings.channel.telegramReady")
        : t("settings.channel.telegramTodo");
    case 'notifyx':
      return settings.notifyxApiKey.trim() ? t("settings.channel.notifyxReady") : t("settings.channel.notifyxTodo");
    case 'webhook':
      return settings.webhookUrl.trim()
        ? t("settings.channel.webhookReady", { method: settings.webhookMethod })
        : t("settings.channel.webhookTodo");
    case 'dingtalk':
      return settings.dingtalkWebhookUrl.trim() ? t("settings.channel.dingtalkReady") : t("settings.channel.dingtalkTodo");
    case 'wechat':
      return settings.wechatWebhookUrl.trim() ? t("settings.channel.wechatReady") : t("settings.channel.wechatTodo");
    case 'email':
      return settings.recipientEmail.trim() ? t("settings.channel.emailReady") : t("settings.channel.emailTodo");
    case 'bark':
      return settings.barkDeviceKey.trim() ? t("settings.channel.barkReady") : t("settings.channel.barkTodo");
    case 'serverchan':
      return settings.serverchanSendKey.trim() ? t("settings.channel.serverchanReady") : t("settings.channel.serverchanTodo");
    case 'discord':
      return settings.discordWebhookUrl.trim() ? t("settings.channel.discordReady") : t("settings.channel.discordTodo");
    case 'pushplus':
      return settings.pushplusToken.trim() ? t("settings.channel.pushplusReady") : t("settings.channel.pushplusTodo");
  }
}


function NotificationChannelRow({
  channel,
  settings,
  selected,
  enabled,
  disabled,
  onSelect,
  onToggle,
}: {
  channel: NotificationChannel;
  settings: AppSettings;
  selected: boolean;
  enabled: boolean;
  disabled: boolean;
  onSelect: (channel: NotificationChannel) => void;
  onToggle: (channel: NotificationChannel) => void;
}) {
  const { t, label } = useI18n();
  const channelLabel = label(CHANNEL_LABELS[channel]);
  const checkboxId = `notification-channel-${channel}`;

  return (
    <div
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 rounded-lg border border-border bg-secondary/30 px-4 py-3 transition-colors',
        selected && 'border-primary/60 bg-primary/5',
      )}
    >
      <div className="flex h-5 items-center">
        <Checkbox
          id={checkboxId}
          checked={enabled}
          aria-label={`${enabled ? t("common.disable") : t("common.enable")} ${channelLabel}`}
          disabled={disabled}
          onCheckedChange={() => onToggle(channel)}
        />
      </div>
      <button
        type="button"
        className="min-w-0 text-left"
        onClick={() => onSelect(channel)}
        aria-current={selected ? 'true' : undefined}
      >
        <span className="flex min-h-5 flex-wrap items-center gap-2">
          <span className="text-sm font-medium leading-5 text-foreground">{channelLabel}</span>
          <span className="inline-flex h-5 items-center rounded-md border border-border bg-background/60 px-2 text-[10px] leading-none text-muted-foreground">
            {enabled ? t("common.enabled") : t("common.disabled")}
          </span>
        </span>
        <span className="mt-1 block truncate text-xs leading-5 text-muted-foreground">
          {getNotificationChannelSummary(settings, channel, t)}
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 self-start text-muted-foreground hover:text-foreground"
        onClick={() => onSelect(channel)}
        aria-label={`${t("common.configure")} ${channelLabel}`}
      >
        {t("common.configure")}
      </Button>
    </div>
  );
}

export function NotificationChannelList({
  settings,
  activeChannel,
  onSelect,
  onToggle,
  disabled = false,
}: {
  settings: AppSettings;
  activeChannel: NotificationChannel;
  onSelect: (channel: NotificationChannel) => void;
  onToggle: (channel: NotificationChannel) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid content-start gap-3">
      <Label>{t("settings.notificationChannels")}</Label>
      <div className="grid gap-3">
        {NOTIFICATION_CHANNELS.map((channel) => (
          <NotificationChannelRow
            key={channel}
            channel={channel}
            settings={settings}
            selected={activeChannel === channel}
            enabled={settings.enabledChannels.includes(channel)}
            disabled={disabled}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

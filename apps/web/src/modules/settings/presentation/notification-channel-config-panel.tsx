/**
 * 通知渠道配置面板。
 *
 * 架构位置：按渠道展示凭据、模板和测试按钮；敏感配置的校验与发送仍由后端通知模块负责。
 *
 * 注意： Webhook/DingTalk/WeCom/Bark/Discord URL 最终会触发后端外连，展示层不能把“看起来像 URL”当作安全保证。
 */
import { useRef, useState } from 'react';
import { Bot, ExternalLink, Check, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, FormFieldRow } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NumericInput } from '@/components/ui/numeric-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages';
import {
  CHANNEL_LABELS,
  type AppSettings,
  type NotificationChannel,
} from '@/types/subscription';
import { ChoiceRadioGroup, CheckboxSettingRow, LoadingButtonContent, type UpdateSetting } from './settings-shared-controls';
import { NotificationDingTalkConfigPanel, NotificationWebhookConfigPanel } from './notification-webhook-dingtalk-configs';
import type { SettingsTelegramBotCommandsController } from '../application/use-telegram-bot-commands-controller';
import type { SettingsSecretKey, SettingsSecretStatus } from '@/lib/api/schemas/settings';
import { ManagerDataBoundary } from './manager-data-boundary';
import { TelegramBotCommandsDeleteDialog } from './telegram-bot-commands-delete-dialog';
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
const NOTIFICATION_TEST_LABEL_KEYS: Record<NotificationChannel, MessageKey> = {
  telegram: "settings.testChannel.telegram",
  notifyx: "settings.testChannel.notifyx",
  webhook: "settings.testChannel.webhook",
  dingtalk: "settings.testChannel.dingtalk",
  wechat: "settings.testChannel.wechat",
  email: "settings.testChannel.email",
  bark: "settings.testChannel.bark",
  serverchan: "settings.testChannel.serverchan",
  discord: "settings.testChannel.discord",
  pushplus: "settings.testChannel.pushplus",
};

const TELEGRAM_BOT_COMMAND_STATUS_LABEL_KEYS = {
  not_configured: "settings.telegramBotCommandsStatus.notConfigured",
  not_installed: "settings.telegramBotCommandsStatus.notInstalled",
  installing: "settings.telegramBotCommandsStatus.installing",
  installed: "settings.telegramBotCommandsStatus.installed",
} as const satisfies Record<string, MessageKey>;

const SMTP_PORT_MAX = 65_535;

const CHANNEL_SECRET_KEYS: Record<NotificationChannel, SettingsSecretKey[]> = {
  telegram: ["telegramBotToken"],
  notifyx: ["notifyxApiKey"],
  webhook: ["webhookUrl", "webhookHeaders"],
  dingtalk: ["dingtalkWebhookUrl", "dingtalkSecret"],
  wechat: ["wechatWebhookUrl"],
  email: ["smtpPassword"],
  bark: ["barkDeviceKey"],
  serverchan: ["serverchanSendKey"],
  discord: ["discordWebhookUrl"],
  pushplus: ["pushplusToken"],
};

type NumericAllowedValues = {
  floatValue: number | undefined;
  value: string;
};

function isAllowedSmtpPortValue(values: NumericAllowedValues) {
  return values.value === "" || (
    /^[1-9]\d{0,4}$/.test(values.value)
    && values.floatValue !== undefined
    && values.floatValue <= SMTP_PORT_MAX
  );
}

function NotificationTestButton({
  channel,
  label,
  testingChannel,
  onTest,
  disabled,
}: {
  channel: NotificationChannel;
  label: string;
  testingChannel: NotificationChannel | null;
  onTest: (channel: NotificationChannel) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const isTesting = testingChannel === channel;

  return (
    <Button
      type="button"
      variant="outline"
      className="relative border-primary text-primary hover:bg-primary/10"
      onClick={() => onTest(channel)}
      disabled={disabled || testingChannel !== null}
      aria-busy={isTesting ? true : undefined}
    >
      <LoadingButtonContent loading={isTesting} loadingLabel={t("settings.testing")}>
        <Check aria-hidden="true" className="h-4 w-4" />
        {label}
      </LoadingButtonContent>
    </Button>
  );
}


function getNotificationChannelHelp(channel: NotificationChannel, t: Translate): { href: string; label: string } | null {
  switch (channel) {
    case 'telegram':
      return { href: 'https://t.me/botfather', label: t("settings.help.telegram") };
    case 'webhook':
      return { href: 'https://en.wikipedia.org/wiki/Webhook', label: t("settings.help.webhook") };
    case 'dingtalk':
      return { href: 'https://dingtalk.apifox.cn/doc-3550006.md', label: t("settings.help.dingtalk") };
    case 'wechat':
      return { href: 'https://developer.work.weixin.qq.com/document/path/91770', label: t("settings.help.wechat") };
    case 'bark':
      return { href: 'https://github.com/Finb/Bark', label: t("settings.help.bark") };
    case 'notifyx':
      return { href: 'https://www.notifyx.cn/help', label: t("settings.help.notifyx") };
    case 'serverchan':
      return { href: 'https://sct.ftqq.com/', label: t("settings.help.serverchan") };
    case 'discord':
      return { href: 'https://docs.discord.com/developers/resources/webhook', label: t("settings.help.discord") };
    case 'pushplus':
      return { href: 'https://www.pushplus.plus/doc/guide/api.html', label: t("settings.help.pushplus") };
    case 'email':
      return null;
  }
}


export function NotificationChannelConfigPanel({
  channel,
  settings,
  enabled,
  updateSetting,
  testingChannel,
  onTest,
  disabled = false,
  telegramBotCommands,
  secretStatus,
  onClearSecret,
}: {
  channel: NotificationChannel;
  settings: AppSettings;
  enabled: boolean;
  updateSetting: UpdateSetting;
  testingChannel: NotificationChannel | null;
  onTest: (channel: NotificationChannel) => void;
  disabled?: boolean;
  telegramBotCommands?: SettingsTelegramBotCommandsController;
  secretStatus?: SettingsSecretStatus;
  onClearSecret?: (key: SettingsSecretKey) => void;
}) {
  const { t, label, formatDateTime } = useI18n();
  const [deleteCommandsOpen, setDeleteCommandsOpen] = useState(false);
  const telegramCommandsFocusFallbackRef = useRef<HTMLButtonElement>(null);
  const help = getNotificationChannelHelp(channel, t);
  const channelLabel = label(CHANNEL_LABELS[channel]);
  const testChannelLabel = t(NOTIFICATION_TEST_LABEL_KEYS[channel], { channel: channelLabel });
  const commandData = telegramBotCommands?.readState.data;
  const commandStatus = commandData?.status;
  // 刷新失败由读取边界唯一标记“未更新”；Badge 继续显示缓存命令状态，避免 stale 提示覆盖领域事实。
  const commandStatusLabel = !telegramBotCommands
    ? t("settings.statusUnknown")
    : telegramBotCommands.readState.isInitialLoading
      ? t("common.loading")
      : !telegramBotCommands.readState.hasData && telegramBotCommands.readState.error
        ? t("settings.statusUnknown")
        : commandStatus
          ? t(TELEGRAM_BOT_COMMAND_STATUS_LABEL_KEYS[commandStatus])
          : t("settings.statusUnknown");
  const commandBindingPresent = commandStatus === "installed" || commandStatus === "installing";
  const commandInstalling = Boolean(telegramBotCommands?.isInstalling) || commandStatus === "installing";
  const commandInstallDisabled = Boolean(telegramBotCommands?.installDisabledReason) || !telegramBotCommands || !telegramBotCommands.readState.hasData || telegramBotCommands.isDeleting || commandInstalling;
  const commandDeleteDisabled = Boolean(telegramBotCommands?.deleteDisabledReason) || !telegramBotCommands || !telegramBotCommands.readState.hasData || commandInstalling || !commandBindingPresent;
  const commandInstallDisabledReason = telegramBotCommands?.installDisabledReason;
  const commandInstallDisabledReasonVisible = commandInstallDisabledReason && !commandInstalling;
  const commandTime = (value: string | null | undefined) => value
    ? formatDateTime(value, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : t("settings.telegramBotCommandsNever");
  const configuredSecrets = CHANNEL_SECRET_KEYS[channel].filter((key) => secretStatus?.[key]?.configured);

  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-4">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">{t("settings.channelConfig", { channel: channelLabel })}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {enabled ? t("settings.channelEnabledHelp") : t("settings.channelDisabledHelp")}
          </p>
        </div>
        {help ? (
          <a
            href={help.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            {help.label}
          </a>
        ) : null}
      </div>

      {configuredSecrets.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="configured-channel-secrets">
          {configuredSecrets.map((key) => (
            <div key={key} className="inline-flex items-center gap-1.5">
              <Badge variant="secondary">{t("settings.turnstileSecretConfigured")}</Badge>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                disabled={disabled}
                onClick={() => onClearSecret?.(key)}
                title={t("settings.turnstileClearSecret")}
                aria-label={`${t("settings.turnstileClearSecret")}: ${key}`}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {channel === 'telegram' ? (
        <>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="telegramBot">{t("settings.telegramBotTokenLabel")}</Label>
              <Input
                id="telegramBot"
                placeholder="xx:xxxxxxxxx-token"
                value={settings.telegramBotToken}
                disabled={disabled}
                onChange={(e) => updateSetting('telegramBotToken', e.target.value)}
                className="border-border bg-secondary"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="telegramChat">{t("settings.telegramChatIdLabel")}</Label>
              <Input
                id="telegramChat"
                placeholder={t("settings.telegramChatPlaceholder")}
                value={settings.telegramChatId}
                disabled={disabled}
                onChange={(e) => updateSetting('telegramChatId', e.target.value)}
                className="border-border bg-secondary"
              />
            </div>
            <ChoiceRadioGroup
              id="telegramMessageFormat"
              label={t("settings.telegramMessageFormat")}
              value={settings.telegramMessageFormat}
              disabled={disabled}
              onValueChange={(format) => updateSetting("telegramMessageFormat", format)}
              options={[
                {
                  value: "plain",
                  label: t("settings.telegramMessageFormatPlain"),
                  description: t("settings.telegramMessageFormatPlainDescription"),
                },
                {
                  value: "html",
                  label: t("settings.telegramMessageFormatHtml"),
                  description: t("settings.telegramMessageFormatHtmlDescription"),
                },
              ]}
            />
          </div>
          <div className="mt-4 flex flex-col items-start gap-2 sm:items-end">
            <NotificationTestButton
              channel="telegram"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          </div>
          {telegramBotCommands ? (
            <div className="mt-4 rounded-md border border-border bg-background/70 p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-primary" />
                    <h4 className="text-sm font-medium text-foreground">{t("settings.telegramBotCommands")}</h4>
                    <Badge variant={commandData?.installed ? "default" : "secondary"}>{commandStatusLabel}</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("settings.telegramBotCommandsHelp")}</p>
                  <ManagerDataBoundary state={telegramBotCommands.readState}>
                    <div className="mt-2 grid gap-1 text-xs leading-5 text-muted-foreground">
                      <span>{t("settings.telegramBotCommandsChat", { chatId: commandData?.chatId ?? t("settings.telegramBotCommandsMissing") })}</span>
                      <span>{t("settings.telegramBotCommandsInstalledAt", { time: commandTime(commandData?.installedAt) })}</span>
                      <span>{t("settings.telegramBotCommandsLastUsedAt", { time: commandTime(commandData?.lastUsedAt) })}</span>
                    </div>
                  </ManagerDataBoundary>
                  {commandInstallDisabledReasonVisible ? (
                    <p className="mt-2 text-xs font-medium text-muted-foreground">{commandInstallDisabledReason}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                  <Button
                    ref={telegramCommandsFocusFallbackRef}
                    type="button"
                    size="sm"
                    onClick={() => {
                      void telegramBotCommands.install();
                    }}
                    disabled={commandInstallDisabled}
                    aria-busy={commandInstalling ? true : undefined}
                    className="justify-center"
                  >
                    <LoadingButtonContent loading={commandInstalling} loadingLabel={t("settings.telegramBotCommandsInstalling")}>
                      {commandData?.installed ? t("settings.telegramBotCommandsReinstall") : t("settings.telegramBotCommandsInstall")}
                    </LoadingButtonContent>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteCommandsOpen(true)}
                    disabled={commandDeleteDisabled}
                    aria-busy={telegramBotCommands.isDeleting ? true : undefined}
                    className="justify-center gap-2 text-destructive hover:text-destructive"
                  >
                    <LoadingButtonContent loading={telegramBotCommands.isDeleting} loadingLabel={t("settings.telegramBotCommandsDeleting")}>
                      <Trash2 className="h-4 w-4" />
                      {t("settings.telegramBotCommandsDelete")}
                    </LoadingButtonContent>
                  </Button>
                </div>
              </div>
              <TelegramBotCommandsDeleteDialog
                open={deleteCommandsOpen}
                pending={telegramBotCommands.isDeleting}
                focusFallbackRef={telegramCommandsFocusFallbackRef}
                onOpenChange={setDeleteCommandsOpen}
                onDelete={telegramBotCommands.deleteCommands}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {channel === 'notifyx' ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="notifyxKey">{t("settings.apiKeyLabel")}</Label>
            <Input
              id="notifyxKey"
              placeholder="napi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={settings.notifyxApiKey}
              disabled={disabled}
              onChange={(e) => updateSetting('notifyxApiKey', e.target.value)}
              className="border-border bg-secondary"
            />
            <p className="text-xs text-muted-foreground">{t("settings.notifyxHelp")}</p>
          </div>
          <div className="mt-4 flex justify-end">
            <NotificationTestButton
              channel="notifyx"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          </div>
        </>
      ) : null}

      {channel === 'webhook' ? (
        <NotificationWebhookConfigPanel
          settings={settings}
          updateSetting={updateSetting}
          disabled={disabled}
          testButton={(
            <NotificationTestButton
              channel="webhook"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          )}
        />
      ) : null}

      {channel === 'dingtalk' ? (
        <NotificationDingTalkConfigPanel
          settings={settings}
          updateSetting={updateSetting}
          disabled={disabled}
          testButton={(
            <NotificationTestButton
              channel="dingtalk"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          )}
        />
      ) : null}

      {channel === 'wechat' ? (
        <>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="wechatUrl">{t("settings.wechatUrl")}</Label>
              <Input
                id="wechatUrl"
                name="wechatUrl"
                type="url"
                inputMode="url"
                enterKeyHint="next"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx"
                value={settings.wechatWebhookUrl}
                disabled={disabled}
                onChange={(e) => updateSetting('wechatWebhookUrl', e.target.value)}
                className="border-border bg-secondary"
              />
              <p className="text-xs text-muted-foreground">{t("settings.wechatHelp")}</p>
            </div>
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
              <FormField id="wechatMsgType" label={t("settings.messageType")}>
                {({ id }) => (
                  <Select
                    value={settings.wechatMessageType}
                    disabled={disabled}
                    onValueChange={(value) => updateSetting('wechatMessageType', value as 'text' | 'markdown')}
                  >
                    <SelectTrigger id={id} className="border-border bg-secondary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">{t("settings.textMessage")}</SelectItem>
                      <SelectItem value="markdown">Markdown</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </FormFieldRow>
            <CheckboxSettingRow
              id="wechatModeTag"
              checked={settings.wechatAddModeTag}
              onCheckedChange={(checked) => updateSetting('wechatAddModeTag', checked)}
              label={t("settings.wechatModeTag")}
              disabled={disabled}
            />
            <div className="grid gap-2">
              <Label htmlFor="wechatPhones">{t("settings.wechatPhones")}</Label>
              <Input
                id="wechatPhones"
                name="wechatPhones"
                type="tel"
                inputMode="tel"
                enterKeyHint="next"
                autoComplete="tel"
                placeholder="135xxxxxxxx,136xxxxxxxx"
                value={settings.wechatAtPhones}
                disabled={disabled}
                onChange={(e) => updateSetting('wechatAtPhones', e.target.value)}
                className="border-border bg-secondary"
              />
              <p className="text-xs text-muted-foreground">{t("settings.wechatPhonesHelp")}</p>
            </div>
            <CheckboxSettingRow
              id="wechatAtAll"
              checked={settings.wechatAtAll}
              onCheckedChange={(checked) => updateSetting('wechatAtAll', checked)}
              label={t("settings.wechatAtAll")}
              disabled={disabled}
            />
          </div>
          <div className="mt-4 flex justify-end">
            <NotificationTestButton
              channel="wechat"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          </div>
        </>
      ) : null}

      {channel === 'email' ? (
        <>
          <div className="grid gap-4">
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
              <FormField id="smtpHost" label={t("settings.smtpHost")}>
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="smtp.example.com"
                    value={settings.smtpHost}
                    disabled={disabled}
                    onChange={(e) => updateSetting('smtpHost', e.target.value)}
                    className="border-border bg-secondary"
                  />
                )}
              </FormField>
              <FormField id="smtpPort" label={t("settings.smtpPort")}>
                {({ id }) => (
                  <NumericInput
                    id={id}
                    name="smtpPort"
                    inputMode="numeric"
                    enterKeyHint="next"
                    placeholder="587"
                    value={settings.smtpPort}
                    allowNegative={false}
                    decimalScale={0}
                    isAllowed={isAllowedSmtpPortValue}
                    disabled={disabled}
                    onRawValueChange={(value) => updateSetting('smtpPort', value)}
                    className="border-border bg-secondary"
                  />
                )}
              </FormField>
            </FormFieldRow>
            <CheckboxSettingRow
              id="smtpSecure"
              checked={settings.smtpSecure}
              onCheckedChange={(checked) => updateSetting('smtpSecure', checked)}
              label={t("settings.smtpSecure")}
              description={t("settings.smtpSecureHelp")}
              disabled={disabled}
            />
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
              <FormField id="smtpUser" label={t("settings.smtpUser")}>
                {({ id }) => (
                  <Input
                    id={id}
                    name="smtpUser"
                    value={settings.smtpUser}
                    disabled={disabled}
                    onChange={(e) => updateSetting('smtpUser', e.target.value)}
                    className="border-border bg-secondary"
                    autoComplete="username"
                    enterKeyHint="next"
                  />
                )}
              </FormField>
              <FormField id="smtpPassword" label={t("settings.smtpPassword")}>
                {({ id }) => (
                  <Input
                    id={id}
                    name="smtpPassword"
                    type="password"
                    value={settings.smtpPassword}
                    disabled={disabled}
                    onChange={(e) => updateSetting('smtpPassword', e.target.value)}
                    className="border-border bg-secondary"
                    autoComplete="new-password"
                    enterKeyHint="next"
                  />
                )}
              </FormField>
            </FormFieldRow>
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
              <FormField id="smtpFrom" label={t("settings.smtpFrom")}>
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="Renewlet <noreply@example.com>"
                    value={settings.smtpFrom}
                    disabled={disabled}
                    onChange={(e) => updateSetting('smtpFrom', e.target.value)}
                    className="border-border bg-secondary"
                  />
                )}
              </FormField>
              <FormField id="smtpReplyTo" label={t("settings.smtpReplyTo")}>
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="support@example.com"
                    value={settings.smtpReplyTo}
                    disabled={disabled}
                    onChange={(e) => updateSetting('smtpReplyTo', e.target.value)}
                    className="border-border bg-secondary"
                  />
                )}
              </FormField>
            </FormFieldRow>
            <p className="text-xs text-muted-foreground">
              {t("settings.smtpHelp")}
            </p>
            <CheckboxSettingRow
              id="notifyMultipleAddresses"
              checked={settings.notifyMultipleAddresses}
              onCheckedChange={(checked) => updateSetting('notifyMultipleAddresses', checked)}
              label={t("settings.multipleRecipients")}
              description={t("settings.multipleRecipientsHelp")}
              disabled={disabled}
            />
            <div className="grid gap-2">
              <Label htmlFor="recipientEmail">{t("settings.recipientEmail")}</Label>
              <Input
                id="recipientEmail"
                type={settings.notifyMultipleAddresses ? 'text' : 'email'}
                placeholder={settings.notifyMultipleAddresses ? 'a@example.com, b@example.com' : 'user@example.com'}
                value={settings.recipientEmail}
                disabled={disabled}
                onChange={(e) => updateSetting('recipientEmail', e.target.value)}
                className="border-border bg-secondary"
              />
              <p className="text-xs text-muted-foreground">{t("settings.recipientEmailHelp")}</p>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <NotificationTestButton
              channel="email"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          </div>
        </>
      ) : null}

      {channel === 'bark' ? (
        <>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="barkUrl">{t("settings.barkServer")}</Label>
              <Input
                id="barkUrl"
                placeholder="https://api.day.app"
                value={settings.barkServerUrl}
                disabled={disabled}
                onChange={(e) => updateSetting('barkServerUrl', e.target.value)}
                className="border-border bg-secondary"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.barkServerHelp")}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="barkKey">{t("settings.barkKey")}</Label>
              <Input
                id="barkKey"
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
                value={settings.barkDeviceKey}
                disabled={disabled}
                onChange={(e) => updateSetting('barkDeviceKey', e.target.value)}
                className="border-border bg-secondary"
              />
              <p className="text-xs text-muted-foreground">{t("settings.barkKeyHelp")}</p>
            </div>
            <CheckboxSettingRow
              id="barkSilent"
              checked={settings.barkSilentPush}
              onCheckedChange={(checked) => updateSetting('barkSilentPush', checked)}
              label={t("settings.barkSilent")}
              description={t("settings.barkSilentHelp")}
              disabled={disabled}
            />
          </div>
          <div className="mt-4 flex justify-end">
            <NotificationTestButton
              channel="bark"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          </div>
        </>
      ) : null}

      {channel === 'serverchan' ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="serverchanSendKey">{t("settings.serverchanSendKey")}</Label>
            <Input
              id="serverchanSendKey"
              name="serverchanSendKey"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t("settings.serverchanSendKeyPlaceholder")}
              value={settings.serverchanSendKey}
              disabled={disabled}
              onChange={(e) => updateSetting('serverchanSendKey', e.target.value)}
              className="border-border bg-secondary"
            />
            <p className="text-xs text-muted-foreground">{t("settings.serverchanHelp")}</p>
          </div>
          <div className="mt-4 flex justify-end">
            <NotificationTestButton
              channel="serverchan"
              label={testChannelLabel}
              testingChannel={testingChannel}
              onTest={onTest}
              disabled={disabled}
            />
          </div>
        </>
      ) : null}

      {channel === 'discord' ? (
        <>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="discordWebhookUrl">{t("settings.discordWebhookUrl")}</Label>
              <Input
                id="discordWebhookUrl"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://discord.com/api/webhooks/..."
                value={settings.discordWebhookUrl}
                disabled={disabled}
                onChange={(e) => updateSetting('discordWebhookUrl', e.target.value)}
                className="border-border bg-secondary"
              />
              <p className="text-xs text-muted-foreground">{t("settings.discordWebhookHelp")}</p>
            </div>
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
              <FormField id="discordBotUsername" label={t("settings.discordBotUsername")}>
                {({ id }) => (
                  <Input
                    id={id}
                    value={settings.discordBotUsername}
                    disabled={disabled}
                    onChange={(e) => updateSetting('discordBotUsername', e.target.value)}
                    className="border-border bg-secondary"
                  />
                )}
              </FormField>
              <FormField id="discordBotAvatarUrl" label={t("settings.discordBotAvatarUrl")}>
                {({ id }) => (
                  <Input
                    id={id}
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="https://cdn.example.com/avatar.png"
                    value={settings.discordBotAvatarUrl}
                    disabled={disabled}
                    onChange={(e) => updateSetting('discordBotAvatarUrl', e.target.value)}
                    className="border-border bg-secondary"
                  />
                )}
              </FormField>
            </FormFieldRow>
          </div>
          <div className="mt-4 flex justify-end">
            <NotificationTestButton channel="discord" label={testChannelLabel} testingChannel={testingChannel} onTest={onTest} disabled={disabled} />
          </div>
        </>
      ) : null}

      {channel === 'pushplus' ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="pushplusToken">{t("settings.pushplusToken")}</Label>
            <Input
              id="pushplusToken"
              autoCapitalize="none"
              spellCheck={false}
              value={settings.pushplusToken}
              disabled={disabled}
              onChange={(e) => updateSetting('pushplusToken', e.target.value)}
              className="border-border bg-secondary"
            />
            <p className="text-xs text-muted-foreground">{t("settings.pushplusHelp")}</p>
          </div>
          <div className="mt-4 flex justify-end">
            <NotificationTestButton channel="pushplus" label={testChannelLabel} testingChannel={testingChannel} onTest={onTest} disabled={disabled} />
          </div>
        </>
      ) : null}
    </div>
  );
}

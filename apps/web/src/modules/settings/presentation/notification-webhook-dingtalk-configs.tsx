import { useState, type ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField, FormFieldRow } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n/I18nProvider';
import {
  WEBHOOK_HEADERS_PLACEHOLDER,
  WEBHOOK_PAYLOAD_PLACEHOLDER,
  type AppSettings,
} from '@/types/subscription';
import type { UpdateSetting } from './settings-shared-controls';

type NotificationProtocolConfigProps = {
  settings: AppSettings;
  updateSetting: UpdateSetting;
  disabled: boolean;
  testButton: ReactNode;
};

export function NotificationWebhookConfigPanel({
  settings,
  updateSetting,
  disabled,
  testButton,
}: NotificationProtocolConfigProps) {
  const { t } = useI18n();

  return (
    <>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="webhookUrl">{t("settings.webhookUrlLabel")}</Label>
          <Input
            id="webhookUrl"
            name="webhookUrl"
            type="url"
            inputMode="url"
            enterKeyHint="next"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://your-webhook-endpoint.com/path"
            value={settings.webhookUrl}
            disabled={disabled}
            onChange={(e) => updateSetting('webhookUrl', e.target.value)}
            className="border-border bg-secondary"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.webhookGetPostHelp")}
          </p>
        </div>
        <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
          <FormField id="webhookMethod" label={t("settings.webhookMethod")}>
            {({ id }) => (
              <Select
                value={settings.webhookMethod}
                disabled={disabled}
                onValueChange={(value) => updateSetting('webhookMethod', value as 'GET' | 'POST')}
              >
                <SelectTrigger id={id} className="border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="GET">GET</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
        </FormFieldRow>
        <div className="grid gap-2">
          <Label htmlFor="webhookHeaders">{t("settings.webhookHeaders")}</Label>
          <Textarea
            id="webhookHeaders"
            placeholder={WEBHOOK_HEADERS_PLACEHOLDER}
            value={settings.webhookHeaders}
            disabled={disabled}
            onChange={(e) => updateSetting('webhookHeaders', e.target.value)}
            className="min-h-20 border-border bg-secondary font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("settings.webhookHeadersHelp")}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="webhookPayload">{t("settings.webhookPayload")}</Label>
          <Textarea
            id="webhookPayload"
            placeholder={WEBHOOK_PAYLOAD_PLACEHOLDER}
            value={settings.webhookPayload}
            disabled={disabled}
            onChange={(e) => updateSetting('webhookPayload', e.target.value)}
            className="min-h-20 border-border bg-secondary font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.webhookPayloadHelp")}
          </p>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        {testButton}
      </div>
    </>
  );
}

export function NotificationDingTalkConfigPanel({
  settings,
  updateSetting,
  disabled,
  testButton,
}: NotificationProtocolConfigProps) {
  const { t } = useI18n();
  const [templateExamplesOpen, setTemplateExamplesOpen] = useState(false);
  const templateExamples = [
    {
      id: 'default',
      name: t("settings.dingtalkTemplateExampleDefault"),
      title: t("settings.dingtalkTemplateExampleDefaultTitle"),
      content: t("settings.dingtalkTemplateExampleDefaultContent"),
    },
    {
      id: 'keyword',
      name: t("settings.dingtalkTemplateExampleKeyword"),
      title: t("settings.dingtalkTemplateExampleKeywordTitle"),
      content: t("settings.dingtalkTemplateExampleKeywordContent"),
    },
    {
      id: 'count',
      name: t("settings.dingtalkTemplateExampleCount"),
      title: t("settings.dingtalkTemplateExampleCountTitle"),
      content: t("settings.dingtalkTemplateExampleCountContent"),
    },
  ] as const;

  const applyTemplateExample = (title: string, content: string) => {
    updateSetting('dingtalkTitleTemplate', title);
    updateSetting('dingtalkContentTemplate', content);
    setTemplateExamplesOpen(false);
  };

  return (
    <>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="dingtalkWebhookUrl">{t("settings.dingtalkWebhookUrl")}</Label>
          <Input
            id="dingtalkWebhookUrl"
            name="dingtalkWebhookUrl"
            type="url"
            inputMode="url"
            enterKeyHint="next"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            value={settings.dingtalkWebhookUrl}
            disabled={disabled}
            onChange={(e) => updateSetting('dingtalkWebhookUrl', e.target.value)}
            className="border-border bg-secondary"
          />
          <p className="text-xs text-muted-foreground">{t("settings.dingtalkWebhookHelp")}</p>
        </div>
        <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
          <FormField id="dingtalkMessageType" label={t("settings.messageType")}>
            {({ id }) => (
              <Select
                value={settings.dingtalkMessageType}
                disabled={disabled}
                onValueChange={(value) => updateSetting('dingtalkMessageType', value as 'markdown' | 'text')}
              >
                <SelectTrigger id={id} className="border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="markdown">Markdown</SelectItem>
                  <SelectItem value="text">{t("settings.textMessage")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField id="dingtalkTitleTemplate" label={t("settings.dingtalkTitleTemplate")}>
            {({ id }) => (
              <Input
                id={id}
                autoCapitalize="none"
                spellCheck={false}
                placeholder={t("settings.dingtalkTitleTemplatePlaceholder")}
                value={settings.dingtalkTitleTemplate}
                disabled={disabled}
                onChange={(e) => updateSetting('dingtalkTitleTemplate', e.target.value)}
                className="border-border bg-secondary"
              />
            )}
          </FormField>
        </FormFieldRow>
        <div className="grid gap-2">
          <Label htmlFor="dingtalkContentTemplate">{t("settings.dingtalkContentTemplate")}</Label>
          <Textarea
            id="dingtalkContentTemplate"
            placeholder={t("settings.dingtalkContentTemplatePlaceholder")}
            value={settings.dingtalkContentTemplate}
            disabled={disabled}
            onChange={(e) => updateSetting('dingtalkContentTemplate', e.target.value)}
            className="min-h-30 border-border bg-secondary font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("settings.dingtalkTemplateHelp")}</p>
          <Popover open={templateExamplesOpen} onOpenChange={setTemplateExamplesOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                className="h-8 w-fit gap-1.5 border-border px-2.5 text-xs"
              >
                <BookOpen aria-hidden="true" className="h-4 w-4" />
                {t("settings.dingtalkTemplateExamplesOpen")}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              mobileTitle={t("settings.dingtalkTemplateExamples")}
              mobileDescription={t("settings.dingtalkTemplateExamplesDescription")}
              mobileCloseLabel={t("common.close")}
              mobilePresentation="sheet"
              className="flex max-h-[min(calc(var(--app-viewport-height)-1rem),var(--radix-popover-content-available-height,28rem))] w-[min(calc(100vw-2rem),24rem)] flex-col rounded-xl border-border bg-card p-0 shadow-xl"
            >
              <div className="hidden shrink-0 border-b border-border px-3 py-3 md:block">
                <p className="text-sm font-semibold text-foreground">{t("settings.dingtalkTemplateExamples")}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("settings.dingtalkTemplateExamplesDescription")}
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {templateExamples.map((example) => (
                  <button
                    key={example.id}
                    type="button"
                    disabled={disabled}
                    aria-label={t("settings.dingtalkTemplateExampleApplyNamed", { name: example.name })}
                    onClick={() => applyTemplateExample(example.title, example.content)}
                    className="grid w-full min-w-0 gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="text-sm font-medium text-foreground">{example.name}</span>
                    <span className="grid min-w-0 gap-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
                      <span className="min-w-0 truncate">{example.title}</span>
                      <span className="line-clamp-2 min-w-0 whitespace-pre-wrap wrap-break-word">{example.content}</span>
                    </span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="dingtalkKeyword">{t("settings.dingtalkKeyword")}</Label>
          <Input
            id="dingtalkKeyword"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t("settings.dingtalkKeywordPlaceholder")}
            value={settings.dingtalkKeyword}
            disabled={disabled}
            onChange={(e) => updateSetting('dingtalkKeyword', e.target.value)}
            className="border-border bg-secondary"
          />
          <p className="text-xs text-muted-foreground">{t("settings.dingtalkKeywordHelp")}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="dingtalkSecret">{t("settings.dingtalkSecret")}</Label>
          <Input
            id="dingtalkSecret"
            type="password"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="new-password"
            value={settings.dingtalkSecret}
            disabled={disabled}
            onChange={(e) => updateSetting('dingtalkSecret', e.target.value)}
            className="border-border bg-secondary"
          />
          <p className="text-xs text-muted-foreground">{t("settings.dingtalkSecretHelp")}</p>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        {testButton}
      </div>
    </>
  );
}

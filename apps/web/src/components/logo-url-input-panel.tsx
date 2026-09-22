import { useId, useMemo, useState } from "react";
import { Image as ImageIcon, Link, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { FaviconResultImage } from "@/components/favicon-result-image";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import {
  LOGO_URL_INPUT_MAX_LENGTH,
  resolveDisplayLogoSrc,
  validateCustomLogoUrlInput,
  type LogoUrlValidationCode,
} from "@/lib/logo-url";
import { cn } from "@/lib/utils";

interface LogoUrlInputPanelProps {
  /** 当前持久化的 Logo URL；非法历史值不会回填到输入框，避免用户误保存旧风险值。 */
  value?: string | null | undefined;
  /** 只在校验通过后输出规范化 URL；调用方负责关闭弹层或写入表单。 */
  onApply: (value: string) => void;
  className?: string | undefined;
  /** 小尺寸用于导入 sheet，桌面表单保持默认密度。 */
  size?: "sm" | "md" | undefined;
}

const validationMessageKeys: Record<LogoUrlValidationCode, MessageKey> = {
  empty: "media.logoLinkRequired",
  tooLong: "media.logoLinkTooLong",
  invalid: "media.logoLinkInvalid",
  scheme: "media.logoLinkSchemeInvalid",
  host: "media.logoLinkHostInvalid",
  userinfo: "media.logoLinkUserInfoInvalid",
};

function initialLogoUrl(value: string | null | undefined): string {
  if (!value) return "";
  const validation = validateCustomLogoUrlInput(value);
  // 只回填当前输入框契约允许的 http(s) 外链；私有资产路径和旧非法值由上传/选择流程管理。
  return validation.ok ? validation.value : "";
}

/**
 * LogoUrlInputPanel 处理用户手填 Logo 外链。
 *
 * 预览阶段会按当前页面协议临时升级 http 图片；真正持久化仍保存用户输入的规范化 URL，
 * 让后端和后续导出能保留原始外部引用。
 */
export function LogoUrlInputPanel({
  value,
  onApply,
  className,
  size = "md",
}: LogoUrlInputPanelProps) {
  const { t } = useI18n();
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const previewId = `${inputId}-preview`;
  const [rawValue, setRawValue] = useState(() => initialLogoUrl(value));
  const [validationRequested, setValidationRequested] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const validation = useMemo(() => validateCustomLogoUrlInput(rawValue), [rawValue]);
  const displaySrc = validation.ok ? resolveDisplayLogoSrc(validation.value) : undefined;
  const upgradedForPreview = validation.ok && displaySrc !== undefined && displaySrc !== validation.value;
  // 弹层自动关闭会先触发输入框 blur；只有显式提交才展示错误，避免关闭动画里闪红。
  const showError = validationRequested && !validation.ok;
  const isSmall = size === "sm";

  const errorMessage = showError && !validation.ok
    ? t(validationMessageKeys[validation.code], { max: LOGO_URL_INPUT_MAX_LENGTH })
    : undefined;

  const applyLogoLink = () => {
    setValidationRequested(true);
    if (validation.ok) onApply(validation.value);
  };

  return (
    <div className={cn("grid gap-3", className)}>
      <FormField
        id={inputId}
        describedBy={validation.ok ? previewId : undefined}
        error={errorMessage}
        errorId={errorId}
      >
        {(field) => (
          <Input
            id={field.id}
            type="url"
            inputMode="url"
            value={rawValue}
            maxLength={LOGO_URL_INPUT_MAX_LENGTH}
            placeholder="https://example.com/logo.svg"
            aria-invalid={field.invalid}
            aria-describedby={field.describedBy}
            className={cn(isSmall && "h-9 text-sm")}
            onChange={(event) => {
              setRawValue(event.target.value);
              setPreviewFailed(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              applyLogoLink();
            }}
          />
        )}
      </FormField>

      {validation.ok ? (
        <div
          id={previewId}
          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border border-border bg-secondary/30 p-2"
        >
          <div className={cn(
            "media-thumbnail-canvas flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background p-1",
            isSmall ? "h-10 w-10" : "h-12 w-12",
          )}>
            {displaySrc && !previewFailed ? (
              <FaviconResultImage
                src={displaySrc}
                alt={t("media.logoLinkPreviewAlt")}
                className="media-thumbnail-image"
                onError={() => setPreviewFailed(true)}
              />
            ) : (
              <ImageIcon className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            {displaySrc === undefined ? (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("media.logoLinkHttpIpBlocked")}</span>
              </p>
            ) : previewFailed ? (
              <p className="text-xs text-muted-foreground">{t("media.logoLinkPreviewFailed")}</p>
            ) : upgradedForPreview ? (
              <p className="text-xs text-muted-foreground">{t("media.logoLinkPreviewUpgraded")}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("media.logoLinkPreviewReady")}</p>
            )}
          </div>
        </div>
      ) : null}

      <Button
        type="button"
        size="sm"
        className="w-full gap-2"
        onClick={applyLogoLink}
      >
        <Link className="h-4 w-4" />
        {t("media.useLogoLink")}
      </Button>
    </div>
  );
}

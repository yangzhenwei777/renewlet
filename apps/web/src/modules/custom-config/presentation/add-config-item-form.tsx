/**
 * 自定义配置新增项表单。
 *
 * 架构位置：只负责采集 label/color/icon/enabled 等展示输入，新增规则由
 * 复杂状态由 use-config-manager-controller 与 normalize-custom-config 兜底。
 *
 * 注意： 图标上传是异步流程；提交按钮必须尊重上传状态，避免把 dataURL 或半成品写入配置。
 */
import { Suspense } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nProvider";
import type { LocalizedLabels } from "@/i18n/locales";
import type { UploadStatus as IconUploadStatus } from "@/hooks/use-cropped-image-upload";
import { ColorPicker } from "./color-picker";
import { IconPickerFallback, LazyIconPicker } from "./icon-picker-loader";

export interface AddConfigItemFormProps {
  showColor: boolean;
  showIcon: boolean;
  colorOptions: string[];
  newValue: string;
  setNewValue: (value: string) => void;
  newLabels: LocalizedLabels;
  setNewLabels: (value: LocalizedLabels) => void;
  newColor: string;
  setNewColor: (value: string) => void;
  newIcon: string | undefined;
  setNewIcon: (icon: string | undefined) => void;
  newIconUploadStatus: IconUploadStatus;
  setNewIconUploadStatus: (status: IconUploadStatus) => void;
  handleAdd: () => void;
  resetAddForm: () => void;
}

export function AddConfigItemForm({
  showColor,
  showIcon,
  colorOptions,
  newValue,
  setNewValue,
  newLabels,
  setNewLabels,
  newColor,
  setNewColor,
  newIcon,
  setNewIcon,
  newIconUploadStatus,
  setNewIconUploadStatus,
  handleAdd,
  resetAddForm,
}: AddConfigItemFormProps) {
  const { t } = useI18n();

  return (
            <div className="grid gap-3 rounded-lg border-2 border-dashed border-border bg-secondary/50 p-3">
              {showIcon && (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t("customConfig.iconLabel")}</span>
                  <Suspense fallback={<IconPickerFallback size="sm" />}>
                    <LazyIconPicker
                      value={newIcon}
                      onChange={setNewIcon}
                      onUploadStatusChange={setNewIconUploadStatus}
                      searchHint={newLabels["zh-CN"] || newLabels["en-US"]}
                      size="sm"
                    />
                  </Suspense>
                  {newIconUploadStatus === "uploading" && (
                    <span className="text-xs text-muted-foreground">{t("common.uploading")}</span>
                  )}
                  {newIconUploadStatus === "error" && (
                    <span className="text-xs text-destructive">{t("common.uploadFailed")}</span>
                  )}
                </div>
              )}
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <Plus className="h-4 w-4 text-primary shrink-0" />
                <Input
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder={t("customConfig.valuePlaceholder")}
                  className="h-8 w-full text-sm sm:w-24"
                  autoFocus
                />
                <Input
                  value={newLabels["zh-CN"]}
                  onChange={(e) => setNewLabels({ ...newLabels, "zh-CN": e.target.value })}
                  placeholder={t("customConfig.labelZhPlaceholder")}
                  className="h-8 min-w-0 text-sm sm:flex-1"
                />
                <Input
                  value={newLabels["en-US"]}
                  onChange={(e) => setNewLabels({ ...newLabels, "en-US": e.target.value })}
                  placeholder={t("customConfig.labelEnPlaceholder")}
                  className="h-8 min-w-0 text-sm sm:flex-1"
                />
                {showColor && (
                  <ColorPicker
                    color={newColor}
                    onChange={setNewColor}
                    presetColors={colorOptions}
                  />
                )}
                <div className="flex gap-1 self-end sm:self-auto">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleAdd}
                    disabled={newIconUploadStatus !== "idle"}
                  >
                    {newIconUploadStatus === "uploading" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <Check className="h-4 w-4 text-primary" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={resetAddForm}
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            </div>
    
  );
}

/**
 * 自定义配置排序项。
 *
 * 架构位置：展示单个 ConfigItem 的编辑、启用、删除和拖拽手柄；业务约束由上层 controller 注入。
 *
 * 注意： 内置项和被订阅引用的分类可能不能删除，按钮禁用原因必须跟 controller 保持一致。
 */
import { memo, Suspense } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { TruncatedTooltipText } from "@/components/ui/truncated-tooltip-text";
import { AuthorizedImage } from "@/components/authorized-image";
import { Check, Edit2, GripVertical, Image as ImageIcon, Loader2, Trash2, X } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";
import type { LocalizedLabels } from "@/i18n/locales";
import { cn } from "@/lib/utils";
import type { UploadStatus as IconUploadStatus } from "@/hooks/use-cropped-image-upload";
import type { ConfigItem } from "@/types/config";
import { ColorPicker } from "./color-picker";
import { IconPickerFallback, LazyIconPicker, preloadIconPicker } from "./icon-picker-loader";

export interface SortableConfigItemProps {
  /** 当前渲染的配置项。 */
  item: ConfigItem;
  /** 是否为“系统内置”项（仅用于展示徽标/提示）。 */
  isSystemItem: boolean;
  /** 是否展示颜色编辑/展示。 */
  showColor: boolean;
  /** 是否展示图标编辑/展示。 */
  showIcon: boolean;
  /** 只读模式：禁止编辑/删除。 */
  readOnly: boolean;
  /** toggle 模式：展示 enabled 开关。 */
  toggleMode: boolean;
  /** 当前 item 是否处于编辑态。 */
  isEditing: boolean;
  /** 编辑态：value 的临时输入值。 */
  editValue: string;
  /** 编辑态：labels 的临时输入值。 */
  editLabels: LocalizedLabels;
  /** 编辑态：color 的临时输入值。 */
  editColor: string;
  /** 编辑态：icon 的临时输入值。 */
  editIcon: string | undefined;
  /** 预设颜色列表（传给 ColorPicker）。 */
  colorOptions: string[];
  /** 进入编辑态。 */
  onStartEdit: () => void;
  /** 保存编辑态的改动。 */
  onSaveEdit: () => void;
  /** 取消编辑态。 */
  onCancelEdit: () => void;
  /** 删除当前 item。 */
  onDelete: () => void;
  /** toggle 模式：切换 enabled。 */
  onToggle: () => void;
  /** 更新 editValue。 */
  onEditValueChange: (value: string) => void;
  /** 更新 editLabels。 */
  onEditLabelsChange: (value: LocalizedLabels) => void;
  /** 更新 editColor。 */
  onEditColorChange: (value: string) => void;
  /** 更新 editIcon。 */
  onEditIconChange: (icon: string | undefined) => void;
  /** 图标上传状态（用于禁用“保存”并显示 loading）。 */
  iconUploadStatus: IconUploadStatus;
  /** 图标上传状态变更回调。 */
  onIconUploadStatusChange: (status: IconUploadStatus) => void;
}

export const SortableConfigItem = memo(function SortableConfigItem({
  item,
  isSystemItem,
  showColor,
  showIcon,
  readOnly,
  toggleMode,
  isEditing,
  editValue,
  editLabels,
  editColor,
  editIcon,
  colorOptions,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onToggle,
  onEditValueChange,
  onEditLabelsChange,
  onEditColorChange,
  onEditIconChange,
  iconUploadStatus,
  onIconUploadStatusChange,
}: SortableConfigItemProps) {
  const { t, label } = useI18n();
  const itemLabel = label(item.labels);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      data-config-manager-item=""
      style={style}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-3 rounded-lg border border-border bg-secondary/50 p-3",
        isDragging && "opacity-50 shadow-lg",
        isEditing && "ring-2 ring-primary",
      )}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={t("customConfig.dragNamed", { label: itemLabel })}
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4 text-muted-foreground/50" />
      </button>

      {isEditing ? (
        <div className="min-w-0 flex-1 grid gap-3">
          {showIcon && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("customConfig.iconLabel")}</span>
              <Suspense fallback={<IconPickerFallback size="sm" />}>
                <LazyIconPicker
                  value={editIcon}
                  onChange={onEditIconChange}
                  onUploadStatusChange={onIconUploadStatusChange}
                  searchHint={editLabels["zh-CN"] || editLabels["en-US"]}
                  size="sm"
                />
              </Suspense>
              {iconUploadStatus === "uploading" && (
                <span className="text-xs text-muted-foreground">{t("common.uploading")}</span>
              )}
              {iconUploadStatus === "error" && (
                <span className="text-xs text-destructive">{t("common.uploadFailed")}</span>
              )}
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={editValue}
              onChange={(e) => onEditValueChange(e.target.value)}
              placeholder={t("customConfig.valuePlaceholder")}
              className="h-8 w-full text-sm sm:w-24"
            />
            <Input
              value={editLabels["zh-CN"]}
              onChange={(e) => onEditLabelsChange({ ...editLabels, "zh-CN": e.target.value })}
              placeholder={t("customConfig.labelZhPlaceholder")}
              className="h-8 min-w-0 text-sm sm:flex-1"
            />
            <Input
              value={editLabels["en-US"]}
              onChange={(e) => onEditLabelsChange({ ...editLabels, "en-US": e.target.value })}
              placeholder={t("customConfig.labelEnPlaceholder")}
              className="h-8 min-w-0 text-sm sm:flex-1"
            />
            {showColor && (
              <ColorPicker
                color={editColor}
                onChange={onEditColorChange}
                presetColors={colorOptions}
              />
            )}
            <div className="flex gap-1 self-end sm:self-auto">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onSaveEdit}
                disabled={showIcon === true && iconUploadStatus !== "idle"}
                aria-label={t("customConfig.saveNamed", { label: itemLabel })}
              >
                {iconUploadStatus === "uploading" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onCancelEdit}
                aria-label={t("customConfig.cancelEditNamed", { label: itemLabel })}
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {showIcon && (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded bg-background/50">
              {item.icon ? (
                <AuthorizedImage src={item.icon} alt="" className="w-5 h-5 object-contain" />
              ) : (
                <ImageIcon className="w-3.5 h-3.5 text-muted-foreground/30" />
              )}
            </div>
          )}
          {showColor && item.color && (
            <div
              className="h-4 w-4 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
          )}
          <span className="max-w-[40%] shrink-0 truncate rounded bg-background/50 px-2 py-0.5 font-mono text-xs text-muted-foreground sm:max-w-none">
            {item.value}
          </span>
          <TruncatedTooltipText
            text={itemLabel}
            className="min-w-0 flex-1 text-sm"
          />

          {isSystemItem && !toggleMode && (
            <span className="hidden shrink-0 rounded-md border border-border bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
              {t("common.builtIn")}
            </span>
          )}

          {toggleMode ? (
            <Switch
              checked={item.enabled !== false}
              onCheckedChange={onToggle}
              aria-label={t("customConfig.toggleNamed", { label: itemLabel })}
            />
          ) : !readOnly && (
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => {
                  if (showIcon) preloadIconPicker();
                  onStartEdit();
                }}
                onFocus={showIcon ? preloadIconPicker : undefined}
                onPointerEnter={showIcon ? preloadIconPicker : undefined}
                aria-label={t("customConfig.editNamed", { label: itemLabel })}
              >
                <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 hover:text-destructive"
                onClick={onDelete}
                aria-label={t("customConfig.deleteNamed", { label: itemLabel })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );

});

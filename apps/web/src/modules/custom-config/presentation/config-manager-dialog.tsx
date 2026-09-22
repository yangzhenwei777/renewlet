/**
 * 通用配置管理弹窗（拖拽排序 + 新增/编辑/删除/启用）。
 *
 * 架构位置：
 * - 属于 custom-config 模块的 presentation 层，只渲染 controller 给出的状态和事件。
 * - 持久化由 Context/application hook 处理，domain 负责规范化和内置项约束。
 *
 * 当前用于：
 * - 设置页「数据配置」：分类 / 状态 / 支付方式 / 货币
 *
 * 状态链路：
 * ```
 * SettingsScreen -> ConfigManagerDialog -> useConfigManagerController
 *     -> onUpdate(items) -> CustomConfigProvider -> localStorage + /api/custom-config
 * ```
 *
 * 注意： 不要在本组件里直接调用 API 或 toast，否则会重新把展示层和应用层耦合。
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus, ChevronRight, Search } from 'lucide-react';
import type { ConfigItem } from '@/types/config';
import { useConfigManagerController } from '@/modules/custom-config/application/use-config-manager-controller';
import { ConfigManagerSortableList } from '@/modules/custom-config/presentation/config-manager-sortable-list';
import { useI18n } from '@/i18n/I18nProvider';
import { rankSearchText } from '@/lib/searchable-options';
import { SettingsManagerDialogFrame } from '@/modules/settings/presentation/settings-manager-dialog-frame';

const DEFAULT_COLORS = [
  'hsl(160 84% 45%)',
  'hsl(200 80% 50%)',
  'hsl(280 70% 55%)',
  'hsl(35 90% 55%)',
  'hsl(350 75% 55%)',
  'hsl(180 60% 45%)',
  'hsl(45 90% 50%)',
  'hsl(320 70% 55%)',
];

interface ConfigManagerDialogProps {
  title: string;
  description?: string;
  items: ConfigItem[];
  onUpdate: (items: ConfigItem[]) => void;
  showColor?: boolean;
  showIcon?: boolean;
  colorOptions?: string[];
  maxItems?: number;
  icon?: ReactNode;
  readOnly?: boolean;
  toggleMode?: boolean;
  /**
   * 是否将某个 item 视为“系统内置项”（仅对该 item 禁止编辑/删除，但仍允许拖拽排序）。
   *
   * 用途：
   * - 内置支付方式：图标/名称固定，不允许删除/修改
   * - 用户自定义项：允许自由编辑/删除
   */
  isItemReadOnly?: (item: ConfigItem) => boolean;
  /**
   * 删除前校验：返回阻止删除的原因（返回 null 表示允许删除）。
   *
   * 典型场景：
   * - 分类：若该分类被订阅使用中，则阻止删除并提示先调整订阅
   */
  getDeleteBlockReason?: (item: ConfigItem) => string | null;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchEmptyMessage?: string;
  getSearchKeywords?: (item: ConfigItem) => string[];
}

export const ConfigManagerDialog = ({
  title,
  description,
  items,
  onUpdate,
  showColor = false,
  showIcon = false,
  colorOptions = DEFAULT_COLORS,
  maxItems = 20,
  icon,
  readOnly = false,
  toggleMode = false,
  isItemReadOnly,
  getDeleteBlockReason,
  searchable = false,
  searchPlaceholder,
  searchEmptyMessage,
  getSearchKeywords,
}: ConfigManagerDialogProps) => {
  const { t, label } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const deleteFocusFallbackRef = useRef<HTMLButtonElement>(null);
  // controller 统一维护编辑/新增/删除的互斥状态，presentation 只做事件转发。
  const controller = useConfigManagerController({
    items,
    onUpdate,
    showColor,
    showIcon,
    colorOptions,
    maxItems,
    readOnly,
    toggleMode,
    isItemReadOnly,
    getDeleteBlockReason,
  });

  const {
    open,
    editingId,
    deleteTarget,
    editValue,
    setEditValue,
    editLabels,
    setEditLabels,
    editColor,
    setEditColor,
    editIcon,
    setEditIcon,
    editIconUploadStatus,
    setEditIconUploadStatus,
    isAdding,
    setIsAdding,
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
    enabledCount,
    resetAddForm,
    handleDragEnd,
    handleStartEdit,
    handleSaveEdit,
    handleCancelEdit,
    handleRequestDelete,
    handleAdd,
    handleConfirmDelete,
    handleCancelDelete,
    handleToggle,
    handleOpenChange,
    getDeleteReason,
  } = controller;
  const filteredItems = useMemo(() => {
    const query = searchQuery.trim();
    if (!searchable || !query) return items;
    return items.filter((item) => {
      const keywords = getSearchKeywords?.(item) ?? [
        item.value,
        item.labels["zh-CN"],
        item.labels["en-US"],
      ];
      return rankSearchText(keywords, query) > 0;
    });
  }, [getSearchKeywords, items, searchable, searchQuery]);
  const handleDialogOpenChange = (nextOpen: boolean) => {
    handleOpenChange(nextOpen);
    if (!nextOpen) setSearchQuery("");
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogTrigger asChild>
        <button
          className="flex items-center justify-between w-full p-4 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors text-left group"
        >
          <div className="flex items-center gap-3">
            {icon && <div className="text-primary">{icon}</div>}
            <div>
              <div className="font-medium text-sm">{title}</div>
              <div className="text-xs text-muted-foreground">
                {toggleMode
                  ? t("customConfig.enabledCount", { enabled: enabledCount, total: items.length })
                  : t("common.options", { count: items.length })}
              </div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
      </DialogTrigger>
      <SettingsManagerDialogFrame
        icon={icon && <div className="text-primary">{icon}</div>}
        title={title}
        description={description ?? t("customConfig.srDescription", { title })}
        bodyClassName="flex flex-col"
        footer={(
          <Button ref={deleteFocusFallbackRef} type="button" onClick={() => handleDialogOpenChange(false)} className="w-full sm:w-auto">
            {t("common.close")}
          </Button>
        )}
      >
        <div data-config-manager-controls="" className="grid shrink-0 gap-3">
          <p className="min-w-0 wrap-break-word text-xs text-muted-foreground">
            {toggleMode
              ? t("customConfig.dragSortEnabled", { enabled: enabledCount, total: items.length })
              : readOnly
                ? t("customConfig.dragSortOnly")
                : t("customConfig.dragSort")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {searchable ? (
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={searchPlaceholder ?? t("common.searchPlaceholder")}
                  aria-label={searchPlaceholder ?? t("common.searchPlaceholder")}
                  className="border-border bg-secondary pl-9"
                />
              </div>
            ) : null}
            {!readOnly && !toggleMode && !isAdding && items.length < maxItems ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setIsAdding(true)}
              >
                <Plus className="mr-1 h-4 w-4" />
                {t("customConfig.addOption")}
              </Button>
            ) : null}
          </div>
        </div>

        <div
          data-config-manager-scroll=""
          className="min-h-0 min-w-0 overflow-y-auto py-4 pr-1 sm:pr-2"
        >
          <ConfigManagerSortableList
            items={filteredItems}
            showColor={showColor}
            showIcon={showIcon}
            colorOptions={colorOptions}
            readOnly={readOnly}
            toggleMode={toggleMode}
            isItemReadOnly={isItemReadOnly}
            editingId={editingId}
            editValue={editValue}
            setEditValue={setEditValue}
            editLabels={editLabels}
            setEditLabels={setEditLabels}
            editColor={editColor}
            setEditColor={setEditColor}
            editIcon={editIcon}
            setEditIcon={setEditIcon}
            editIconUploadStatus={editIconUploadStatus}
            setEditIconUploadStatus={setEditIconUploadStatus}
            isAdding={isAdding}
            newValue={newValue}
            setNewValue={setNewValue}
            newLabels={newLabels}
            setNewLabels={setNewLabels}
            newColor={newColor}
            setNewColor={setNewColor}
            newIcon={newIcon}
            setNewIcon={setNewIcon}
            newIconUploadStatus={newIconUploadStatus}
            setNewIconUploadStatus={setNewIconUploadStatus}
            handleDragEnd={handleDragEnd}
            handleStartEdit={handleStartEdit}
            handleSaveEdit={handleSaveEdit}
            handleCancelEdit={handleCancelEdit}
            handleRequestDelete={handleRequestDelete}
            handleAdd={handleAdd}
            resetAddForm={resetAddForm}
            handleToggle={handleToggle}
            emptyMessage={searchQuery.trim() ? searchEmptyMessage : undefined}
          />
        </div>

      </SettingsManagerDialogFrame>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) handleCancelDelete();
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // 删除成功会卸载触发确认框的行，回到稳定的 Footer 操作，避免焦点落到已移除按钮。
            deleteFocusFallbackRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("customConfig.confirmDeleteTitle", { label: deleteTarget ? label(deleteTarget.labels) : "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                if (!deleteTarget) return "";
                const reason = getDeleteReason(deleteTarget);
                if (reason) return reason;
                return t("customConfig.confirmDeleteDescription");
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelDelete}>
              {getDeleteReason(deleteTarget) ? t("common.close") : t("common.cancel")}
            </AlertDialogCancel>
            {deleteTarget && !getDeleteReason(deleteTarget) && (
              <AlertDialogAction
                onClick={handleConfirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t("common.delete")}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};

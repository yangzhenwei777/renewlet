/**
 * 自定义配置弹窗状态机。
 *
 * 架构位置：
 * - presentation 负责 DnD/表单渲染。
 * - 该 hook 负责新增、编辑、删除、排序、启用状态之间的互斥关系。
 * - domain 负责配置数据的规范化和内置项约束。
 *
 * 状态流转：
 * ```
 * 关闭
 *   -> 打开
 *      -> 新增 -> 保存/取消 -> 打开
 *      -> 编辑(item) -> 保存/取消 -> 打开
 *      -> 删除确认(item) -> 确认/取消 -> 打开
 *      -> 拖拽结束/切换启用 -> onUpdate -> 打开
 *   -> 关闭(清理临时状态)
 * ```
 */
import { useCallback, useMemo, useState } from "react";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import type { UploadStatus } from "@/hooks/use-cropped-image-upload";
import type { ConfigItem } from "@/types/config";
import { labels, type LocalizedLabels } from "@/i18n/locales";

type DragEndLikeEvent = {
  active: { id: string | number };
  over: { id: string | number } | null;
};

function moveArrayItem<T>(items: readonly T[], oldIndex: number, newIndex: number): T[] {
  const next = [...items];
  const [item] = next.splice(oldIndex, 1);
  // dnd-kit 只告诉 active/over id；数组移动保持同一 item 引用，避免重建导致图标上传状态丢失。
  next.splice(newIndex, 0, item as T);
  return next;
}

interface UseConfigManagerControllerOptions {
  items: ConfigItem[];
  onUpdate: (items: ConfigItem[]) => void;
  showColor: boolean;
  showIcon: boolean;
  colorOptions: string[];
  maxItems: number;
  readOnly: boolean;
  toggleMode: boolean;
  isItemReadOnly?: ((item: ConfigItem) => boolean) | undefined;
  getDeleteBlockReason?: ((item: ConfigItem) => string | null) | undefined;
}

/**
 * 管理配置弹窗的编辑、新增、删除、排序和启用状态机。
 *
 * 注意： `items` 是上层持有的受控数据。这里不要缓存派生副本，否则拖拽排序、
 * 远端同步和弹窗编辑态之间会出现顺序不一致。
 */
export function useConfigManagerController({
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
}: UseConfigManagerControllerOptions) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConfigItem | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editLabels, setEditLabels] = useState<LocalizedLabels>(() => labels("", ""));
  const [editColor, setEditColor] = useState("");
  const [editIcon, setEditIcon] = useState<string | undefined>(undefined);
  const [editIconUploadStatus, setEditIconUploadStatus] = useState<UploadStatus>("idle");
  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [newLabels, setNewLabels] = useState<LocalizedLabels>(() => labels("", ""));
  const [newColor, setNewColor] = useState(colorOptions[0] ?? "");
  const [newIcon, setNewIcon] = useState<string | undefined>(undefined);
  const [newIconUploadStatus, setNewIconUploadStatus] = useState<UploadStatus>("idle");
  const resetTransientState = useCallback(() => {
    // 关闭时清理临时状态，避免下一次打开继承“编辑中/上传中/待删除”的上下文。
    setEditingId(null);
    setIsAdding(false);
    setDeleteTarget(null);
    setEditIconUploadStatus("idle");
    setNewIconUploadStatus("idle");
  }, []);
  const { scheduleCleanup: scheduleCloseCleanup, cancelCleanup: cancelCloseCleanup } =
    useDeferredDialogCleanup(resetTransientState);

  const enabledCount = useMemo(
    () => items.filter((item) => item.enabled !== false).length,
    [items],
  );

  const resetAddForm = useCallback(() => {
    // 新增表单必须重置上传状态，否则下次打开可能因为上次失败/上传中而无法保存。
    setIsAdding(false);
    setNewValue("");
    setNewLabels(labels("", ""));
    setNewColor(colorOptions[0] ?? "");
    setNewIcon(undefined);
    setNewIconUploadStatus("idle");
  }, [colorOptions]);

  const handleDragEnd = useCallback(
    (event: DragEndLikeEvent) => {
      const { active, over } = event;
      if (!over) return;

      const activeId = String(active.id);
      const overId = String(over.id);
      if (activeId === overId) return;

      const oldIndex = items.findIndex((item) => item.id === activeId);
      const newIndex = items.findIndex((item) => item.id === overId);
      // DnD 事件可能来自已经卸载/过滤掉的节点，忽略比抛错更安全。
      if (oldIndex < 0 || newIndex < 0) return;

      onUpdate(moveArrayItem(items, oldIndex, newIndex));
    },
    [items, onUpdate],
  );

  const handleStartEdit = useCallback(
    (item: ConfigItem) => {
      if (readOnly || toggleMode) return;
      if (isItemReadOnly?.(item) === true) return;
      setEditingId(item.id);
      setEditValue(item.value);
      setEditLabels(item.labels);
      setEditColor(item.color || colorOptions[0] || "");
      setEditIcon(item.icon);
      setEditIconUploadStatus("idle");
    },
    [colorOptions, isItemReadOnly, readOnly, toggleMode],
  );

  const handleSaveEdit = useCallback(() => {
    const nextLabels = labels(editLabels["zh-CN"].trim(), editLabels["en-US"].trim());
    if (!editValue.trim() || !nextLabels["zh-CN"] || !nextLabels["en-US"]) return;
    // 图标上传未完成时禁止保存，避免把临时 data URL 或失败状态持久化进配置。
    if (editIconUploadStatus !== "idle") return;

    onUpdate(
      items.map((item) =>
        item.id === editingId
          ? {
              ...item,
              value: editValue.trim(),
              labels: nextLabels,
              color: showColor ? editColor : item.color,
              icon: showIcon ? editIcon : item.icon,
            }
          : item,
      ),
    );
    setEditingId(null);
    setEditIcon(undefined);
    setEditIconUploadStatus("idle");
  }, [editColor, editIcon, editIconUploadStatus, editLabels, editingId, editValue, items, onUpdate, showColor, showIcon]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditIcon(undefined);
    setEditIconUploadStatus("idle");
  }, []);

  const handleRequestDelete = useCallback(
    (item: ConfigItem) => {
      // 内置项/只读模式的删除保护在这里和展示层双重防御，避免未来 UI 漏禁用按钮。
      if (readOnly || toggleMode) return;
      if (isItemReadOnly?.(item) === true) return;
      setDeleteTarget(item);
    },
    [isItemReadOnly, readOnly, toggleMode],
  );

  const handleAdd = useCallback(() => {
    const nextLabels = labels(newLabels["zh-CN"].trim(), newLabels["en-US"].trim());
    if (!newValue.trim() || !nextLabels["zh-CN"] || !nextLabels["en-US"]) return;
    // 与编辑态一致：上传中的图标不能作为最终配置写入。
    if (newIconUploadStatus !== "idle") return;
    if (items.length >= maxItems) return;

    const newItem: ConfigItem = {
      id: `custom_${Date.now()}`,
      value: newValue.trim(),
      labels: nextLabels,
      color: showColor ? newColor : undefined,
      icon: showIcon ? newIcon : undefined,
      enabled: true,
    };
    onUpdate([...items, newItem]);
    resetAddForm();
  }, [items, maxItems, newColor, newIcon, newIconUploadStatus, newLabels, newValue, onUpdate, resetAddForm, showColor, showIcon]);

  const handleDelete = useCallback(
    (id: string) => {
      if (readOnly || toggleMode) return;
      const target = items.find((item) => item.id === id);
      if (target && isItemReadOnly?.(target) === true) return;
      onUpdate(items.filter((item) => item.id !== id));
    },
    [isItemReadOnly, items, onUpdate, readOnly, toggleMode],
  );

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    if (getDeleteBlockReason?.(deleteTarget)) return;
    handleDelete(deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget, getDeleteBlockReason, handleDelete]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  const handleToggle = useCallback(
    (id: string) => {
      // enabled 采用“缺省即启用”语义，写回 false 才表示禁用，兼容旧配置项缺少 enabled 字段的情况。
      onUpdate(
        items.map((item) =>
          item.id === id ? { ...item, enabled: item.enabled === false ? true : false } : item,
        ),
      );
    },
    [items, onUpdate],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      cancelCloseCleanup();
      return;
    }
    scheduleCloseCleanup();
  }, [cancelCloseCleanup, scheduleCloseCleanup]);

  const getDeleteReason = useCallback(
    (item: ConfigItem | null) => (item ? getDeleteBlockReason?.(item) ?? null : null),
    [getDeleteBlockReason],
  );

  return {
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
  };
}

/**
 * 自定义配置可排序列表。
 *
 * 架构位置：封装 dnd-kit 的传感器和排序上下文，具体增删改禁用状态由 controller 持有。
 *
 * 注意： 拖拽会高频触发顺序更新；不要在列表项内部直接持久化远端配置。
 */
import { memo } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useI18n } from "@/i18n/I18nProvider";
import type { LocalizedLabels } from "@/i18n/locales";
import type { UploadStatus as IconUploadStatus } from "@/hooks/use-cropped-image-upload";
import type { ConfigItem } from "@/types/config";
import { AddConfigItemForm } from "./add-config-item-form";
import { SortableConfigItem } from "./sortable-config-item";

export interface ConfigManagerSortableListProps {
  items: ConfigItem[];
  showColor: boolean;
  showIcon: boolean;
  colorOptions: string[];
  readOnly: boolean;
  toggleMode: boolean;
  isItemReadOnly?: ((item: ConfigItem) => boolean) | undefined;
  editingId: string | null;
  editValue: string;
  setEditValue: (value: string) => void;
  editLabels: LocalizedLabels;
  setEditLabels: (value: LocalizedLabels) => void;
  editColor: string;
  setEditColor: (value: string) => void;
  editIcon: string | undefined;
  setEditIcon: (icon: string | undefined) => void;
  editIconUploadStatus: IconUploadStatus;
  setEditIconUploadStatus: (status: IconUploadStatus) => void;
  isAdding: boolean;
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
  handleDragEnd: (event: DragEndEvent) => void;
  handleStartEdit: (item: ConfigItem) => void;
  handleSaveEdit: () => void;
  handleCancelEdit: () => void;
  handleRequestDelete: (item: ConfigItem) => void;
  handleAdd: () => void;
  resetAddForm: () => void;
  handleToggle: (id: string) => void;
  emptyMessage?: string | undefined;
}

export const ConfigManagerSortableList = memo(function ConfigManagerSortableList({
  items,
  showColor,
  showIcon,
  colorOptions,
  readOnly,
  toggleMode,
  isItemReadOnly,
  editingId,
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
  handleDragEnd,
  handleStartEdit,
  handleSaveEdit,
  handleCancelEdit,
  handleRequestDelete,
  handleAdd,
  resetAddForm,
  handleToggle,
  emptyMessage,
}: ConfigManagerSortableListProps) {
  const { t } = useI18n();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  return (
    <div data-config-manager-list="" className="flex min-w-0 flex-col gap-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {items.map((item) => {
            const systemItem = isItemReadOnly?.(item) === true;
            const itemReadOnly = readOnly || toggleMode || systemItem;

            return (
              <SortableConfigItem
                key={item.id}
                item={item}
                isSystemItem={systemItem}
                showColor={showColor}
                showIcon={showIcon}
                readOnly={itemReadOnly}
                toggleMode={toggleMode}
                isEditing={!itemReadOnly && editingId === item.id}
                editValue={editValue}
                editLabels={editLabels}
                editColor={editColor}
                editIcon={editIcon}
                iconUploadStatus={editIconUploadStatus}
                onIconUploadStatusChange={setEditIconUploadStatus}
                colorOptions={colorOptions}
                onStartEdit={() => handleStartEdit(item)}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={handleCancelEdit}
                onDelete={() => handleRequestDelete(item)}
                onToggle={() => handleToggle(item.id)}
                onEditValueChange={setEditValue}
                onEditLabelsChange={setEditLabels}
                onEditColorChange={setEditColor}
                onEditIconChange={setEditIcon}
              />
            );
          })}
        </SortableContext>
      </DndContext>

      {isAdding && !toggleMode && (
        <AddConfigItemForm
          showColor={showColor}
          showIcon={showIcon}
          colorOptions={colorOptions}
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
          handleAdd={handleAdd}
          resetAddForm={resetAddForm}
        />
      )}

      {items.length === 0 && !isAdding && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          {emptyMessage ?? t("customConfig.empty")}
        </div>
      )}
    </div>
  );
});

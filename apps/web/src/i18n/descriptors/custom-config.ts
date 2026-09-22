// 自定义配置文案覆盖用户可编辑分类/状态/支付/货币管理，和默认配置 labels 的来源保持分离。
import { msg } from "@lingui/core/macro";

export const messages = [
  msg({ id: "customConfig.iconLabel", message: "图标：" }),
  msg({ id: "customConfig.valuePlaceholder", message: "键值" }),
  msg({ id: "customConfig.labelZhPlaceholder", message: "中文名称" }),
  msg({ id: "customConfig.labelEnPlaceholder", message: "英文名称" }),
  msg({ id: "customConfig.customColorPlaceholder", message: "自定义颜色" }),
  msg({ id: "customConfig.empty", message: "暂无配置项" }),
  msg({ id: "customConfig.enabledCount", message: "{enabled}/{total} 已启用" }),
  msg({ id: "customConfig.srDescription", message: "管理{title}的选项、排序和启用状态。" }),
  msg({ id: "customConfig.dragSortEnabled", message: "拖拽排序 · {enabled}/{total} 已启用" }),
  msg({ id: "customConfig.dragSortOnly", message: "仅支持拖拽排序" }),
  msg({ id: "customConfig.dragSort", message: "拖拽排序" }),
  msg({ id: "customConfig.totalItems", message: "共 {count} 项" }),
  msg({ id: "customConfig.addOption", message: "添加选项" }),
  msg({ id: "customConfig.dragNamed", message: "拖动「{label}」排序" }),
  msg({ id: "customConfig.toggleNamed", message: "启用或停用「{label}」" }),
  msg({ id: "customConfig.editNamed", message: "编辑「{label}」" }),
  msg({ id: "customConfig.deleteNamed", message: "删除「{label}」" }),
  msg({ id: "customConfig.saveNamed", message: "保存「{label}」" }),
  msg({ id: "customConfig.cancelEditNamed", message: "取消编辑「{label}」" }),
  msg({ id: "customConfig.confirmDeleteTitle", message: "删除「{label}」？" }),
  msg({ id: "customConfig.confirmDeleteDescription", message: "已有订阅数据会保留；该选项将不再可选，并可能影响展示或筛选。" }),
] as const;

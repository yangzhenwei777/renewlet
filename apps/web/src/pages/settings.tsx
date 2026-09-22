// SettingsScreen 聚合账号、通知、主题、日历 Feed 和自定义配置；路由入口保持薄层，避免页面级状态再分叉。
import { SettingsScreen } from "@/modules/settings/presentation/settings-screen";

export default function SettingsPage() {
  return <SettingsScreen />;
}

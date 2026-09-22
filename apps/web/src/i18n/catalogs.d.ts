// Lingui Vite 插件会把 .po 编译成 messages 对象；声明文件只描述生成模块形状，不承载业务文案。
declare module "*.po" {
  import type { Messages } from "@lingui/core";

  export const messages: Messages;
}

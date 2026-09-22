import type { Messages } from "@lingui/core";
import { messages as admin } from "../catalogs/zh-CN/admin.po";
import { messages as auth } from "../catalogs/zh-CN/auth.po";
import { messages as common } from "../catalogs/zh-CN/common.po";
import { messages as customConfig } from "../catalogs/zh-CN/custom-config.po";
import { messages as error } from "../catalogs/zh-CN/error.po";
import { messages as labels } from "../catalogs/zh-CN/labels.po";
import { messages as legal } from "../catalogs/zh-CN/legal.po";
import { messages as notification } from "../catalogs/zh-CN/notification.po";
import { messages as publicStatus } from "../catalogs/zh-CN/public-status.po";
import { messages as settingsAccessSecurity } from "../catalogs/zh-CN/settings-access-security.po";
import { messages as settings } from "../catalogs/zh-CN/settings.po";
import { messages as subscription } from "../catalogs/zh-CN/subscription.po";

export const messages = {
  ...admin,
  ...auth,
  ...common,
  ...customConfig,
  ...error,
  ...labels,
  ...legal,
  ...notification,
  ...publicStatus,
  ...settingsAccessSecurity,
  ...settings,
  ...subscription,
} satisfies Messages;

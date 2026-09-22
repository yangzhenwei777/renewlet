import type { Messages } from "@lingui/core";
import { messages as admin } from "../catalogs/en-US/admin.po";
import { messages as auth } from "../catalogs/en-US/auth.po";
import { messages as common } from "../catalogs/en-US/common.po";
import { messages as customConfig } from "../catalogs/en-US/custom-config.po";
import { messages as error } from "../catalogs/en-US/error.po";
import { messages as labels } from "../catalogs/en-US/labels.po";
import { messages as legal } from "../catalogs/en-US/legal.po";
import { messages as notification } from "../catalogs/en-US/notification.po";
import { messages as publicStatus } from "../catalogs/en-US/public-status.po";
import { messages as settingsAccessSecurity } from "../catalogs/en-US/settings-access-security.po";
import { messages as settings } from "../catalogs/en-US/settings.po";
import { messages as subscription } from "../catalogs/en-US/subscription.po";

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

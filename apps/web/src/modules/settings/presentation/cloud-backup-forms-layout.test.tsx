import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CloudBackupConnectionForm } from "./cloud-backup-connection-form";
import { CloudBackupPolicyForm } from "./cloud-backup-policy-form";
import type { CloudBackupFormState } from "../application/use-cloud-backup-controller";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "settings.cloudBackupConnection": "连接配置",
      "settings.cloudBackupProviderWebdav": "WebDAV",
      "settings.cloudBackupProviderS3": "S3 兼容存储",
      "settings.cloudBackupWebdavUrl": "WebDAV 地址",
      "settings.cloudBackupWebdavUsername": "用户名",
      "settings.cloudBackupWebdavPassword": "密码",
      "settings.cloudBackupWebdavPath": "远端路径",
      "settings.cloudBackupS3Endpoint": "Endpoint",
      "settings.cloudBackupS3Region": "Region",
      "settings.cloudBackupS3RegionHelp": "Region 说明",
      "settings.cloudBackupS3Bucket": "Bucket",
      "settings.cloudBackupS3Prefix": "Prefix",
      "settings.cloudBackupS3AccessKey": "Access Key",
      "settings.cloudBackupS3Secret": "Secret Key",
      "settings.cloudBackupPathHelp": "路径说明",
      "settings.cloudBackupPolicy": "备份策略",
      "settings.cloudBackupSchedule": "定时自动备份",
      "settings.cloudBackupScheduleHelp": "定时备份说明",
      "settings.cloudBackupFrequency": "频率",
      "settings.cloudBackupFrequencyDaily": "每天",
      "settings.cloudBackupFrequencyWeekly": "每周",
      "settings.cloudBackupScheduleTime": "执行时间",
      "settings.cloudBackupScheduleWeekday": "星期",
      "settings.cloudBackupWeekdayMonday": "星期一",
      "settings.cloudBackupWeekdayTuesday": "星期二",
      "settings.cloudBackupWeekdayWednesday": "星期三",
      "settings.cloudBackupWeekdayThursday": "星期四",
      "settings.cloudBackupWeekdayFriday": "星期五",
      "settings.cloudBackupWeekdaySaturday": "星期六",
      "settings.cloudBackupWeekdaySunday": "星期日",
      "settings.cloudBackupRetention": "保留数量",
    })[key] ?? key,
  }),
}));

const form: CloudBackupFormState = {
  provider: "webdav",
  webdavUrl: "https://dav.example.com",
  webdavUsername: "alice",
  webdavPassword: "",
  webdavPath: "renewlet",
  s3Endpoint: "https://account.r2.cloudflarestorage.com",
  s3Region: "auto",
  s3Bucket: "renewlet",
  s3Prefix: "renewlet",
  s3AccessKeyId: "access",
  s3SecretAccessKey: "",
  scheduleEnabled: true,
  scheduleFrequency: "weekly",
  scheduleTime: "04:30",
  scheduleWeekday: "friday",
  retention: "9",
};

describe("cloud backup form layout", () => {
  it("uses shared two-track and three-track rows for provider fields", () => {
    const props = {
      secretPlaceholder: "留空保留已保存密钥",
      onProviderChange: vi.fn(),
      onTextChange: vi.fn(),
    };
    const { rerender } = render(<CloudBackupConnectionForm form={form} {...props} />);

    expect(screen.getByRole("heading", { name: "连接配置" })).toBeInTheDocument();
    const webdavCredentialsRow = screen.getByLabelText("用户名").closest('[data-slot="form-field-row"]');
    expect(webdavCredentialsRow).toHaveAttribute("data-align-at", "sm");
    expect(webdavCredentialsRow).toHaveAttribute("data-tracks", "2");

    rerender(<CloudBackupConnectionForm form={{ ...form, provider: "s3" }} {...props} />);

    const s3RegionRow = screen.getByLabelText("Region").closest('[data-slot="form-field-row"]');
    expect(s3RegionRow).toHaveAttribute("data-align-at", "sm");
    expect(s3RegionRow).toHaveAttribute("data-tracks", "3");
  });

  it("uses one shared control row for the backup policy fields", () => {
    render(
      <CloudBackupPolicyForm
        scheduleEnabled
        scheduleFrequency="weekly"
        scheduleTime="04:30"
        scheduleWeekday="friday"
        retention="9"
        busy={false}
        onScheduleEnabledChange={vi.fn()}
        onFrequencyChange={vi.fn()}
        onScheduleTimeChange={vi.fn()}
        onScheduleWeekdayChange={vi.fn()}
        onRetentionChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "备份策略" })).toBeInTheDocument();
    const policyRow = screen.getByLabelText("频率").closest('[data-slot="form-field-row"]');
    expect(policyRow).toHaveAttribute("data-align-at", "sm");
    expect(policyRow).toHaveAttribute("data-tracks", "2");
    expect(policyRow?.querySelectorAll('[data-slot="form-field"]')).toHaveLength(4);
  });
});

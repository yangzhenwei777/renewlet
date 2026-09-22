import type { ReactNode } from "react";
import { Cloud, Database } from "lucide-react";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n/I18nProvider";
import type { CloudBackupFormState } from "../application/use-cloud-backup-controller";
import type { CloudBackupProvider } from "@/lib/api/schemas/cloud-backup";

// 连接配置 tab 是 provider 草稿入口；密码/Secret 是 write-only 编辑态，不能从已保存配置回填明文。
export type CloudBackupConnectionField =
  | "webdavUrl"
  | "webdavUsername"
  | "webdavPassword"
  | "webdavPath"
  | "s3Endpoint"
  | "s3Region"
  | "s3Bucket"
  | "s3Prefix"
  | "s3AccessKeyId"
  | "s3SecretAccessKey";

interface CloudBackupConnectionFormProps {
  form: CloudBackupFormState;
  secretPlaceholder: string;
  onProviderChange: (provider: CloudBackupProvider) => void;
  onTextChange: (field: CloudBackupConnectionField, value: string) => void;
  disabled?: boolean;
}

export function CloudBackupConnectionForm({
  form,
  secretPlaceholder,
  onProviderChange,
  onTextChange,
  disabled = false,
}: CloudBackupConnectionFormProps) {
  const { t } = useI18n();

  return (
    <div className="grid gap-4 border-t border-border pt-4">
      <SectionSubheader title={t("settings.cloudBackupConnection")} />
      <Tabs
        value={form.provider}
        onValueChange={(value) => {
          if (!disabled) onProviderChange(value as CloudBackupProvider);
        }}
        className="grid gap-4"
      >
        <TabsList className="grid w-full grid-cols-2 sm:inline-flex sm:w-fit">
          <TabsTrigger value="webdav" className="gap-2" disabled={disabled}>
            <Cloud className="h-4 w-4" />
            {t("settings.cloudBackupProviderWebdav")}
          </TabsTrigger>
          <TabsTrigger value="s3" className="gap-2" disabled={disabled}>
            <Database className="h-4 w-4" />
            {t("settings.cloudBackupProviderS3")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="webdav" className="mt-0">
          <div className="grid max-w-5xl gap-4">
            <FormField id="cloudBackupWebdavUrl" label={t("settings.cloudBackupWebdavUrl")}>
              {({ id }) => (
                <Input
                  id={id}
                  value={form.webdavUrl}
                  disabled={disabled}
                  onChange={(event) => onTextChange("webdavUrl", event.target.value)}
                  placeholder="https://dav.example.com/remote.php/dav/files/user"
                  className="h-9 border-border bg-background"
                  inputMode="url"
                  autoComplete="url"
                />
              )}
            </FormField>
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
              <FormField id="cloudBackupWebdavUsername" label={t("settings.cloudBackupWebdavUsername")}>
                {({ id }) => (
                  <Input
                    id={id}
                    value={form.webdavUsername}
                    disabled={disabled}
                    onChange={(event) => onTextChange("webdavUsername", event.target.value)}
                    className="h-9 border-border bg-background"
                    autoComplete="username"
                  />
                )}
              </FormField>
              <FormField id="cloudBackupWebdavPassword" label={t("settings.cloudBackupWebdavPassword")}>
                {({ id }) => (
                  <Input
                    id={id}
                    type="password"
                    value={form.webdavPassword}
                    disabled={disabled}
                    onChange={(event) => onTextChange("webdavPassword", event.target.value)}
                    placeholder={secretPlaceholder}
                    className="h-9 border-border bg-background"
                    autoComplete="new-password"
                  />
                )}
              </FormField>
            </FormFieldRow>
            <FormField
              id="cloudBackupWebdavPath"
              label={t("settings.cloudBackupWebdavPath")}
              description={t("settings.cloudBackupPathHelp")}
              className="sm:max-w-md"
              descriptionClassName="leading-5"
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  value={form.webdavPath}
                  disabled={disabled}
                  onChange={(event) => onTextChange("webdavPath", event.target.value)}
                  placeholder="renewlet"
                  className="h-9 border-border bg-background"
                  aria-describedby={describedBy}
                />
              )}
            </FormField>
          </div>
        </TabsContent>

        <TabsContent value="s3" className="mt-0">
          <div className="grid max-w-5xl gap-4">
            <FormField id="cloudBackupS3Endpoint" label={t("settings.cloudBackupS3Endpoint")}>
              {({ id }) => (
                <Input
                  id={id}
                  value={form.s3Endpoint}
                  disabled={disabled}
                  onChange={(event) => onTextChange("s3Endpoint", event.target.value)}
                  placeholder="https://<account>.r2.cloudflarestorage.com"
                  className="h-9 border-border bg-background"
                  inputMode="url"
                  autoComplete="url"
                />
              )}
            </FormField>
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-[minmax(10rem,0.45fr)_minmax(0,1fr)]">
              <FormField
                id="cloudBackupS3Region"
                label={t("settings.cloudBackupS3Region")}
                description={t("settings.cloudBackupS3RegionHelp")}
                descriptionClassName="leading-5"
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    value={form.s3Region}
                    disabled={disabled}
                    onChange={(event) => onTextChange("s3Region", event.target.value)}
                    placeholder="auto"
                    className="h-9 border-border bg-background"
                    aria-describedby={describedBy}
                  />
                )}
              </FormField>
              <FormField id="cloudBackupS3Bucket" label={t("settings.cloudBackupS3Bucket")}>
                {({ id }) => (
                  <Input
                    id={id}
                    value={form.s3Bucket}
                    disabled={disabled}
                    onChange={(event) => onTextChange("s3Bucket", event.target.value)}
                    className="h-9 border-border bg-background"
                  />
                )}
              </FormField>
            </FormFieldRow>
            <FormField
              id="cloudBackupS3Prefix"
              label={t("settings.cloudBackupS3Prefix")}
              description={t("settings.cloudBackupPathHelp")}
              className="sm:max-w-xl"
              descriptionClassName="leading-5"
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  value={form.s3Prefix}
                  disabled={disabled}
                  onChange={(event) => onTextChange("s3Prefix", event.target.value)}
                  placeholder="renewlet"
                  className="h-9 border-border bg-background"
                  aria-describedby={describedBy}
                />
              )}
            </FormField>
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
              <FormField id="cloudBackupS3AccessKey" label={t("settings.cloudBackupS3AccessKey")}>
                {({ id }) => (
                  <Input
                    id={id}
                    value={form.s3AccessKeyId}
                    disabled={disabled}
                    onChange={(event) => onTextChange("s3AccessKeyId", event.target.value)}
                    className="h-9 border-border bg-background"
                    autoComplete="username"
                  />
                )}
              </FormField>
              <FormField id="cloudBackupS3Secret" label={t("settings.cloudBackupS3Secret")}>
                {({ id }) => (
                  <Input
                    id={id}
                    type="password"
                    value={form.s3SecretAccessKey}
                    disabled={disabled}
                    onChange={(event) => onTextChange("s3SecretAccessKey", event.target.value)}
                    placeholder={secretPlaceholder}
                    className="h-9 border-border bg-background"
                    autoComplete="new-password"
                  />
                )}
              </FormField>
            </FormFieldRow>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface SectionSubheaderProps {
  title: ReactNode;
}

function SectionSubheader({ title }: SectionSubheaderProps) {
  return <h3 className="text-sm font-semibold text-foreground">{title}</h3>;
}

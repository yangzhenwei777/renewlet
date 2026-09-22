/**
 * Wallos 导入来源能力对照表。
 *
 * 这里不是普通说明卡片：用户会据此选择 JSON/API/ZIP/SQLite 路径，能力矩阵必须和导入解析器的保真度保持一致。
 */
import type { ReactNode } from "react";
import { Archive, ChevronDown, Database, FileJson, Info, KeyRound } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

type WallosCapabilityTone = "good" | "partial" | "bad";

interface WallosCapability {
  label: string;
  tone: WallosCapabilityTone;
}

interface WallosGuideRow {
  source: string;
  icon: ReactNode;
  id: WallosCapability;
  currency: WallosCapability;
  logo: WallosCapability;
  users: WallosCapability;
  match: WallosCapability;
  note: string;
  recommended?: boolean;
}

export function ImportWallosSourceGuide() {
  const { t } = useI18n();
  // 行顺序体现推荐路径：ZIP 能保留本地 logo 和用户信息，所以在视觉上标为 best。
  const rows = [
    {
      source: t("import.wallosGuideJsonTitle"),
      icon: <FileJson className="h-3.5 w-3.5" />,
      id: { label: t("import.wallosGuideValueHash"), tone: "partial" },
      currency: { label: t("import.wallosGuideValueDefaultCurrency"), tone: "partial" },
      logo: { label: t("import.wallosGuideValueAutoLogo"), tone: "partial" },
      users: { label: t("import.wallosGuideValueNone"), tone: "bad" },
      match: { label: t("import.wallosGuideValueLowConfidence"), tone: "partial" },
      note: t("import.wallosGuideJsonNote"),
    },
    {
      source: t("import.wallosGuideApiTitle"),
      icon: <KeyRound className="h-3.5 w-3.5" />,
      id: { label: t("import.wallosGuideValueOriginalId"), tone: "good" },
      currency: { label: t("import.wallosGuideValueCodeOrId"), tone: "good" },
      logo: { label: t("import.wallosGuideValueExternalOrAutoLogo"), tone: "partial" },
      users: { label: t("import.wallosGuideValueOptional"), tone: "partial" },
      match: { label: t("import.wallosGuideValueStable"), tone: "good" },
      note: t("import.wallosGuideApiNote"),
    },
    {
      source: t("import.wallosGuideZipTitle"),
      icon: <Archive className="h-3.5 w-3.5" />,
      id: { label: t("import.wallosGuideValueOriginalId"), tone: "good" },
      currency: { label: t("import.wallosGuideValueCode"), tone: "good" },
      logo: { label: t("import.wallosGuideValueLocalLogo"), tone: "good" },
      users: { label: t("import.wallosGuideValueSupported"), tone: "good" },
      match: { label: t("import.wallosGuideValueStable"), tone: "good" },
      note: t("import.wallosGuideZipNote"),
      recommended: true,
    },
    {
      source: t("import.wallosGuideDbTitle"),
      icon: <Database className="h-3.5 w-3.5" />,
      id: { label: t("import.wallosGuideValueOriginalId"), tone: "good" },
      currency: { label: t("import.wallosGuideValueCode"), tone: "good" },
      logo: { label: t("import.wallosGuideValueFilenameOnly"), tone: "partial" },
      users: { label: t("import.wallosGuideValueSupported"), tone: "good" },
      match: { label: t("import.wallosGuideValueStable"), tone: "good" },
      note: t("import.wallosGuideDbNote"),
    },
  ] satisfies Array<WallosGuideRow>;

  return (
    <details className="group overflow-hidden rounded-lg border border-border bg-secondary/20">
      <summary className="flex cursor-pointer list-none flex-col gap-2 px-3 py-2.5 transition-colors hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Info className="h-4 w-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">{t("import.wallosGuideTitle")}</h3>
          <span className="hidden h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40 sm:block" />
          <p className="hidden truncate text-xs text-muted-foreground sm:block">{t("import.wallosGuideDescription")}</p>
        </div>
        <span className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {t("import.wallosGuideExpand")}
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-190 border-collapse text-xs">
          <caption className="sr-only">{t("import.wallosGuideTitle")}</caption>
          <thead className="bg-background/40 text-[11px] text-muted-foreground">
            <tr>
              <WallosGuideHeader>{t("import.wallosGuideColumnSource")}</WallosGuideHeader>
              <WallosGuideHeader>{t("import.wallosGuideColumnId")}</WallosGuideHeader>
              <WallosGuideHeader>{t("import.wallosGuideColumnCurrency")}</WallosGuideHeader>
              <WallosGuideHeader>{t("import.wallosGuideColumnLogo")}</WallosGuideHeader>
              <WallosGuideHeader>{t("import.wallosGuideColumnUsers")}</WallosGuideHeader>
              <WallosGuideHeader>{t("import.wallosGuideColumnMatch")}</WallosGuideHeader>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.source} className={cn("border-t border-border/70", row.recommended && "bg-primary/5")}>
                <th scope="row" className="w-52.5 px-3 py-2 text-left align-middle">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground",
                      row.recommended && "border-primary/30 bg-primary/10 text-primary",
                    )}>
                      {row.icon}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-foreground">{row.source}</span>
                        {row.recommended ? (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                            {t("import.wallosGuideBest")}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={row.note}>{row.note}</p>
                    </div>
                  </div>
                </th>
                <WallosGuideCell><WallosCapabilityPill {...row.id} /></WallosGuideCell>
                <WallosGuideCell><WallosCapabilityPill {...row.currency} /></WallosGuideCell>
                <WallosGuideCell><WallosCapabilityPill {...row.logo} /></WallosGuideCell>
                <WallosGuideCell><WallosCapabilityPill {...row.users} /></WallosGuideCell>
                <WallosGuideCell><WallosCapabilityPill {...row.match} /></WallosGuideCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function WallosGuideHeader({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-3 py-2 text-left font-medium">{children}</th>;
}

function WallosGuideCell({ children }: { children: ReactNode }) {
  return <td className="px-3 py-2 align-middle">{children}</td>;
}

function WallosCapabilityPill({ label, tone }: WallosCapability) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 text-xs font-medium",
      tone === "good" && "text-primary",
      tone === "partial" && "text-muted-foreground",
      tone === "bad" && "text-destructive",
    )}>
      <span className={cn(
        "h-1.5 w-1.5 rounded-full",
        tone === "good" && "bg-primary",
        tone === "partial" && "bg-muted-foreground",
        tone === "bad" && "bg-destructive",
      )} />
      {label}
    </span>
  );
}

import type { ReactNode } from "react";

interface SettingsSectionHeaderProps {
  icon: ReactNode;
  title: ReactNode;
  help: ReactNode;
  summary?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function SettingsSectionHeader({
  icon,
  title,
  help,
  summary,
  status,
  action,
  className,
}: SettingsSectionHeaderProps) {
  return (
    <div className={className ?? "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"}>
      <div className="flex min-w-0 items-start gap-3">
        {icon}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{help}</p>
          {summary ? <div className="mt-2 text-xs font-medium text-foreground">{summary}</div> : null}
        </div>
      </div>
      {status || action ? (
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          {status}
          {action}
        </div>
      ) : null}
    </div>
  );
}

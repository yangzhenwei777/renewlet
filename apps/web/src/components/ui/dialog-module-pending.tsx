import { useId } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DialogModulePendingProps {
  label: string;
  className?: string;
}

/** 模块等待态只反馈代码就绪状态；业务数据骨架必须留在已加载业务组件自己的布局中。 */
export function DialogModulePending({
  label,
  className,
}: DialogModulePendingProps) {
  const labelId = useId();

  return (
    <div
      role="status"
      aria-labelledby={labelId}
      className={cn("grid min-h-40 min-w-0 place-items-center px-6 py-8", className)}
      data-testid="dialog-module-pending"
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <span id={labelId} className="sr-only">{label}</span>
    </div>
  );
}

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import type { AppSettings } from '@/types/subscription';

export type UpdateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

export interface LoadingButtonContentProps {
  /** 控制是否显示加载层；两层内容都参与固有宽度，避免长 loading 文案贴边或按钮抖动。 */
  loading: boolean;
  loadingLabel: string;
  children: ReactNode;
}

/**
 * 保持按钮加载前后尺寸稳定的内容包装。
 *
 * 注意：settings 页面大量按钮在网格/弹窗 footer 中并排出现，加载时重新排版会放大移动端误触风险。
 */
export function LoadingButtonContent({ loading, loadingLabel, children }: LoadingButtonContentProps) {
  return (
    <span className="inline-grid items-center justify-center">
      <span
        aria-hidden={loading ? true : undefined}
        className={cn("col-start-1 row-start-1 inline-flex items-center justify-center gap-2", loading && "invisible")}
      >
        {children}
      </span>
      <span
        aria-hidden={loading ? undefined : true}
        aria-live={loading ? "polite" : undefined}
        className={cn("col-start-1 row-start-1 inline-flex items-center justify-center gap-2", !loading && "invisible")}
      >
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        {loadingLabel}
      </span>
    </span>
  );
}

export interface CheckboxSettingRowProps {
  /** label 与控件的稳定关联 id；E2E 布局检查依赖这个显式 for/id 关系。 */
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  disabled?: boolean;
}

/** 设置页复用的 checkbox 行，固定 label/control 间距并允许描述文本换行。 */
export function CheckboxSettingRow({
  id,
  checked,
  onCheckedChange,
  label,
  description,
  className,
  disabled = false,
}: CheckboxSettingRowProps) {
  return (
    <div className={cn('grid grid-cols-[auto_1fr] gap-x-3', className)}>
      <div className="flex h-5 items-center">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(nextChecked) => onCheckedChange(nextChecked === true)}
        />
      </div>
      <div className="min-w-0">
        <Label htmlFor={id} className={cn("flex h-5 items-center leading-5", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer")}>
          {label}
        </Label>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

export interface ChoiceRadioGroupOption<TValue extends string> {
  value: TValue;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface ChoiceRadioGroupProps<TValue extends string> {
  id: string;
  label: ReactNode;
  value: TValue;
  options: readonly ChoiceRadioGroupOption<TValue>[];
  onValueChange: (value: TValue) => void;
  className?: string;
  disabled?: boolean;
}

/** 设置页枚举值用 RadioGroup 表达互斥选择，避免把“保存字段”误做成切换内容的 Tabs。 */
export function ChoiceRadioGroup<TValue extends string>({
  id,
  label,
  value,
  options,
  onValueChange,
  className,
  disabled = false,
}: ChoiceRadioGroupProps<TValue>) {
  const labelId = `${id}-label`;

  return (
    <div className={cn("grid gap-2", className)}>
      <Label id={labelId}>{label}</Label>
      <RadioGroup
        value={value}
        onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
        disabled={disabled}
        aria-labelledby={labelId}
        className="grid gap-2"
      >
        {options.map((option) => {
          const optionId = `${id}-${option.value}`;
          const selected = value === option.value;
          const optionDisabled = disabled || option.disabled === true;

          return (
            <Label
              key={option.value}
              htmlFor={optionId}
              className={cn(
                "grid cursor-pointer grid-cols-[auto_1fr] gap-3 rounded-md border border-border bg-background/70 p-3 leading-5 transition-colors",
                selected ? "border-primary/50 bg-primary/10 text-foreground" : "hover:border-primary/30 hover:bg-background",
                optionDisabled && "cursor-not-allowed opacity-70",
              )}
            >
              <span className="flex h-5 items-center">
                <RadioGroupItem id={optionId} value={option.value} disabled={optionDisabled} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                {option.description ? (
                  <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </div>
  );
}

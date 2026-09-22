import { AuthorizedImage } from "@/components/authorized-image";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CreditCard } from "lucide-react";
import type { LocalizedLabels } from "@/i18n/locales";
import type { CustomConfig } from "@/types/config";

interface SubscriptionPaymentMethodSelectProps {
  id?: string | undefined;
  value: string;
  methods: CustomConfig["paymentMethods"];
  labelFor: (labels: LocalizedLabels) => string;
  placeholder: string;
  tooltipContent?: string | undefined;
  onValueChange: (value: string) => void;
}

export function SubscriptionPaymentMethodSelect({
  id,
  value,
  methods,
  labelFor,
  placeholder,
  tooltipContent,
  onValueChange,
}: SubscriptionPaymentMethodSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="border-border bg-secondary" tooltipContent={tooltipContent}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {methods.map((method) => (
          <SelectItem key={method.value} value={method.value}>
            <div className="flex items-center gap-2">
              {method.icon ? (
                // 支付方式图标可能是私有上传资产，必须走 AuthorizedImage 注入当前运行面的认证头。
                <AuthorizedImage src={method.icon} alt="" className="w-4 h-4 object-contain" />
              ) : (
                <CreditCard className="w-4 h-4 text-muted-foreground" />
              )}
              <span>{labelFor(method.labels)}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

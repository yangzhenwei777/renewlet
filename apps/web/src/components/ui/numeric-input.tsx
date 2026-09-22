/**
 * 数值输入原语。
 *
 * 架构位置：把 react-number-format 的格式化能力限制在输入层，业务层仍接收可控字符串/数值。
 *
 * 注意： 不要在这里写订阅价格或预算的业务上限；字段级约束属于表单 schema。
 */
import * as React from "react";
import { NumericFormat } from "react-number-format";

import { Input } from "@/components/ui/input";

type NativeInputProps = React.ComponentPropsWithoutRef<"input">;

const NumericFormatInput = Input as React.ComponentType<NativeInputProps>;

type NumericInputFormatValues = {
  floatValue: number | undefined;
  formattedValue: string;
  value: string;
};

type NumericInputSourceInfo = {
  source: string;
};

type NumericInputFormatProps = {
  allowLeadingZeros?: boolean;
  allowNegative?: boolean;
  allowedDecimalSeparators?: string[];
  decimalScale?: number;
  decimalSeparator?: string;
  fixedDecimalScale?: boolean;
  isAllowed?: (values: NumericInputFormatValues) => boolean;
  prefix?: string;
  suffix?: string;
  thousandSeparator?: boolean | string;
  thousandsGroupStyle?: "thousand" | "lakh" | "wan" | "none";
};

export type NumericInputProps = Omit<
  NativeInputProps,
  "defaultValue" | "inputMode" | "onChange" | "type" | "value"
> &
  NumericInputFormatProps & {
    inputMode?: NativeInputProps["inputMode"];
    value: string | number;
    onRawValueChange: (value: string) => void;
  };

const NumericInput = React.forwardRef<HTMLInputElement, NumericInputProps>(
  ({ inputMode = "decimal", onRawValueChange, value, ...props }, ref) => {
    const numericValue = typeof value === "number" ? String(value) : value;

    return (
      <NumericFormat
        {...props}
        customInput={NumericFormatInput}
        getInputRef={ref}
        inputMode={inputMode}
        onValueChange={(values: NumericInputFormatValues, sourceInfo: NumericInputSourceInfo) => {
          if (String(sourceInfo.source) !== "event") return;
          onRawValueChange(values.value);
        }}
        type="text"
        value={numericValue}
        valueIsNumericString
      />
    );
  },
);
NumericInput.displayName = "NumericInput";

export { NumericInput };

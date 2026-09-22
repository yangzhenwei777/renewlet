import { z } from "zod";

export type MoneyString = string;

export const MONEY_DECIMAL_SCALE = 6;
export const MAX_MONEY_STRING = "1000000000";

const moneyScaleFactor = 10n ** BigInt(MONEY_DECIMAL_SCALE);
const maxMoneyUnits = 1_000_000_000n * moneyScaleFactor;
const decimalPattern = /^\d+(?:\.\d+)?$/;

/**
 * MoneyString 是跨 Docker/Cloudflare/前端的金额事实源：wire 和 storage 都保存 canonical decimal string。
 *
 * 汇率和图表比例仍可用 number；只有用户输入金额通过这里收敛，避免账本金额在 JSON/SQLite/JS 之间丢精度。
 */
export const moneyStringSchema = z.string().trim().transform((value, context): MoneyString => {
  const canonical = canonicalizeMoneyString(value);
  if (canonical !== null) return canonical;
  context.addIssue({ code: "custom", message: "Invalid money amount" });
  return z.NEVER;
});

export function canonicalizeMoneyString(input: string): MoneyString | null {
  const value = input.trim();
  if (!decimalPattern.test(value)) return null;
  const [integerPart = "", fractionPart = ""] = value.split(".");
  if (fractionPart.length > MONEY_DECIMAL_SCALE) return null;
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionPart.replace(/0+$/, "");
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  if (parseMoneyUnits(canonical) > maxMoneyUnits) return null;
  return canonical;
}

export function moneyFromNumber(value: number): MoneyString {
  if (!Number.isFinite(value) || value < 0) return "0";
  return canonicalizeMoneyString(value.toFixed(MONEY_DECIMAL_SCALE)) ?? "0";
}

export function moneyFromUnknown(value: unknown): MoneyString | null {
  if (typeof value === "string") return canonicalizeMoneyString(value);
  if (typeof value === "number") return moneyFromNumber(value);
  return null;
}

export function moneyToNumber(value: MoneyString | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  return Number.parseFloat(canonicalizeMoneyString(value) ?? "0");
}

export function addMoney(...values: Array<MoneyString | number | null | undefined>): MoneyString {
  const total = values.reduce((sum, value) => sum + parseMoneyUnitsFromUnknown(value), 0n);
  return moneyUnitsToString(total);
}

export function subtractMoney(left: MoneyString | number | null | undefined, right: MoneyString | number | null | undefined): number {
  return Number(parseMoneyUnitsFromUnknown(left) - parseMoneyUnitsFromUnknown(right)) / Number(moneyScaleFactor);
}

export function multiplyMoney(value: MoneyString | number | null | undefined, multiplier: number): MoneyString {
  if (!Number.isFinite(multiplier) || multiplier < 0) return "0";
  const scaledMultiplier = BigInt(Math.round(multiplier * Number(moneyScaleFactor)));
  return moneyUnitsToString(roundDiv(parseMoneyUnitsFromUnknown(value) * scaledMultiplier, moneyScaleFactor));
}

export function multiplyMoneyRatio(value: MoneyString | number | null | undefined, numerator: number, denominator: number): MoneyString {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator <= 0) return "0";
  return moneyUnitsToString(roundDiv(parseMoneyUnitsFromUnknown(value) * BigInt(numerator), BigInt(denominator)));
}

export function divideMoney(value: MoneyString | number | null | undefined, denominator: number): MoneyString {
  if (!Number.isInteger(denominator) || denominator <= 0) return "0";
  return moneyUnitsToString(roundDiv(parseMoneyUnitsFromUnknown(value), BigInt(denominator)));
}

export function compareMoney(left: MoneyString | number | null | undefined, right: MoneyString | number | null | undefined): number {
  const delta = parseMoneyUnitsFromUnknown(left) - parseMoneyUnitsFromUnknown(right);
  if (delta < 0n) return -1;
  if (delta > 0n) return 1;
  return 0;
}

export function moneyMin(left: MoneyString | number | null | undefined, right: MoneyString | number | null | undefined): MoneyString {
  return compareMoney(left, right) <= 0 ? moneyUnitsToString(parseMoneyUnitsFromUnknown(left)) : moneyUnitsToString(parseMoneyUnitsFromUnknown(right));
}

export function moneyMax(left: MoneyString | number | null | undefined, right: MoneyString | number | null | undefined): MoneyString {
  return compareMoney(left, right) >= 0 ? moneyUnitsToString(parseMoneyUnitsFromUnknown(left)) : moneyUnitsToString(parseMoneyUnitsFromUnknown(right));
}

function parseMoneyUnitsFromUnknown(value: MoneyString | number | null | undefined): bigint {
  if (typeof value === "number") return parseMoneyUnits(moneyFromNumber(value));
  if (typeof value === "string") return parseMoneyUnits(canonicalizeMoneyString(value) ?? "0");
  return 0n;
}

function parseMoneyUnits(value: MoneyString): bigint {
  const [integerPart = "0", fractionPart = ""] = value.split(".");
  const fraction = (fractionPart + "0".repeat(MONEY_DECIMAL_SCALE)).slice(0, MONEY_DECIMAL_SCALE);
  return BigInt(integerPart) * moneyScaleFactor + BigInt(fraction || "0");
}

function moneyUnitsToString(units: bigint): MoneyString {
  if (units <= 0n) return "0";
  const integer = units / moneyScaleFactor;
  const fraction = units % moneyScaleFactor;
  if (fraction === 0n) return integer.toString();
  return `${integer}.${fraction.toString().padStart(MONEY_DECIMAL_SCALE, "0").replace(/0+$/, "")}`;
}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

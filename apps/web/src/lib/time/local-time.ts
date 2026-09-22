/**
 * 本地墙钟时间工具。
 *
 * `HH:mm` 表示用户所在时区墙上时钟的时间，例如“每天 08:00”。
 * 它不能单独转换成 UTC，必须和 IANA timezone + local date 一起解释。
 */

/** `HH:mm` 墙上时间品牌类型，必须结合时区和日期才能定位到 UTC instant。 */
export type LocalTime = string & { readonly __brand: "LocalTime" };

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 校验 `HH:mm` 是否落在 00:00-23:59 范围内。 */
export function isValidLocalTime(input: string): boolean {
  return LOCAL_TIME_RE.test(input);
}

/** 断言并品牌化本地时间字符串。 */
export function assertLocalTime(input: string): LocalTime {
  if (!isValidLocalTime(input)) {
    throw new Error(`Invalid local time: ${input}`);
  }
  return input as LocalTime;
}

/** 将 `HH:mm` 转成当天分钟数，便于排序和窗口比较。 */
export function localTimeToMinutes(input: LocalTime | string): number {
  const value = assertLocalTime(input);
  const [hh, mm] = value.split(":").map(Number);
  return (hh ?? 0) * 60 + (mm ?? 0);
}

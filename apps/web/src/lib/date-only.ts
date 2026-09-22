/**
 * 业务日期（date-only）工具的兼容出口。
 *
 * 架构位置：
 * - 新代码应优先从 `@/lib/time/date-only` 引入。
 * - 该文件保留为集中迁移出口，避免旧路径散落在业务层。
 *
 * TODO： 当调用方全部切到 `@/lib/time/date-only` 后删除本文件。
 */
export {
  assertDateOnly,
  dateOnlyToLocalDate as parseDateOnly,
  dateToDateOnly,
  isValidDateOnly,
} from "@/lib/time/date-only";

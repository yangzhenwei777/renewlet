// 真实筛选控件和 skeleton 共用同一宽度预算，避免中间视口下加载态与真实态出现列数漂移。
export const subscriptionFilterLayout = {
  desktopRow: "flex flex-wrap items-center gap-3 lg:gap-4",
  desktopSearch: "relative min-w-0 flex-[1_1_14rem]",
  desktopCategoryTrigger: "h-10 w-[min(9.5rem,100%)] justify-start border-border bg-secondary px-3",
  desktopStatusTrigger: "w-[min(8.75rem,100%)] border-border bg-secondary",
  desktopPaymentTypeTrigger: "w-[min(9.5rem,100%)] border-border bg-secondary",
  desktopSortTrigger: "w-[min(12rem,100%)] border-border bg-secondary",
  skeletonSearch: "h-10 min-w-0 flex-[1_1_14rem] rounded-md",
  skeletonCategory: "h-10 w-[min(9.5rem,100%)] rounded-md",
  skeletonStatus: "h-10 w-[min(8.75rem,100%)] rounded-md",
  skeletonPaymentType: "h-10 w-[min(9.5rem,100%)] rounded-md",
  skeletonSort: "h-10 w-[min(12rem,100%)] rounded-md",
} as const;

import type { QueryClient } from "@tanstack/react-query";
import { settingsQueryOptions } from "@/hooks/use-settings";

/** 所有私有路由都依赖远端 locale 与外观；由壳层预取可覆盖冷启动并避免页面各自复制 settings 所有权。 */
export async function preload(queryClient: QueryClient): Promise<void> {
  await queryClient.prefetchQuery(settingsQueryOptions());
}

import { mediaResolverConfig } from "./media-resolver-config";

/**
 * 已知 favicon 域名映射。
 *
 * 这是生成候选 URL 的确定性白名单辅助，不触发后端抓取；浏览器只会加载用户主动搜索得到的图片。
 */
export const KNOWN_FAVICON_DOMAINS: Readonly<Record<string, string>> = mediaResolverConfig.favicon.knownDomains;

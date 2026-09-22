/**
 * 带认证头的图片渲染组件。
 *
 * 架构位置：
 * - 自定义配置和订阅 Logo 可能指向 `/api/app/assets/...` 私有资产。
 * - 私有资产读取依赖 HttpOnly cookie；这里先 credentialed fetch 为 Blob，再转 object URL。
 *
 * 状态链路：
 * ```
 * 图片 src -> 判断是否私有资产 -> 登录态内存缓存/in-flight 复用 -> object URL -> img
 * src 变化/卸载 -> 释放引用 -> 空闲后 revokeObjectURL
 * ```
 *
 * 注意： object URL 必须在 src 变化或卸载时释放，否则长时间管理图标会造成内存泄漏。
 */
import { useEffect, useMemo, useState, type ImgHTMLAttributes } from "react";
import { isExternalHttpImageSrc, resolveDisplayLogoSrc } from "@/lib/logo-url";
import { readProductSessionSnapshot } from "@/services/product-session";

type AuthorizedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  /** 支持私有资产代理路径和外部 http(s) 图片；显示前会按当前页面协议做安全降级/升级。 */
  src: string;
  /** 加载失败只通知调用方切换 fallback，不暴露 fetch 细节。 */
  onError?: (() => void) | undefined;
};

const AUTHORIZED_IMAGE_IDLE_REVOKE_MS = 60_000;

interface AuthorizedImageCacheEntry {
  authKey: string;
  refs: number;
  objectUrl: string | null;
  promise: Promise<string>;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const authorizedImageCache = new Map<string, AuthorizedImageCacheEntry>();

function isPrivateAssetUrl(src: string): boolean {
  if (src.startsWith("/api/app/assets/")) return true;
  try {
    const url = new URL(src, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/app/assets/");
  } catch {
    return false;
  }
}

function authorizedImageAuthKey(): string {
  const snapshot = readProductSessionSnapshot();
  return snapshot ? `${snapshot.userId}:${snapshot.expiresAt}:${snapshot.verifiedAt}` : "";
}

function authorizedImageCacheKey(src: string, authKey: string): string {
  // authKey 只存在内存 Map；用它隔离用户切换后的私有资产 blob URL，不写 storage、不进真实图片 URL。
  return `${authKey}\n${src}`;
}

async function acquireAuthorizedImageObjectUrl(src: string, signal: AbortSignal): Promise<{ objectUrl: string; release: () => void }> {
  const authKey = authorizedImageAuthKey();
  clearIdleAuthorizedImageCacheForOtherAuth(authKey);
  const key = authorizedImageCacheKey(src, authKey);
  let entry = authorizedImageCache.get(key);
  if (!entry) {
    entry = {
      authKey,
      refs: 0,
      objectUrl: null,
      revokeTimer: null,
      promise: fetchAuthorizedImageObjectUrl(src, authKey),
    };
    authorizedImageCache.set(key, entry);
  }
  if (entry.revokeTimer) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  entry.refs += 1;
  try {
    const objectUrl = await entry.promise;
    if (signal.aborted) {
      releaseAuthorizedImageObjectUrl(key);
      throw new DOMException("Aborted", "AbortError");
    }
    return { objectUrl, release: () => releaseAuthorizedImageObjectUrl(key) };
  } catch (error) {
    releaseAuthorizedImageObjectUrl(key);
    if (authorizedImageCache.get(key)?.refs === 0) authorizedImageCache.delete(key);
    throw error;
  }
}

async function fetchAuthorizedImageObjectUrl(src: string, authKey: string): Promise<string> {
  const response = await fetch(src, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const entry = authorizedImageCache.get(authorizedImageCacheKey(src, authKey));
  if (entry) entry.objectUrl = objectUrl;
  return objectUrl;
}

function releaseAuthorizedImageObjectUrl(key: string): void {
  const entry = authorizedImageCache.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0 || entry.revokeTimer) return;
  // object URL 可能被同页多个 logo 共用；最后一个引用释放后短暂保留，吸收列表重排/分页切换造成的重复挂载。
  entry.revokeTimer = setTimeout(() => {
    if (entry.refs > 0) return;
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    authorizedImageCache.delete(key);
  }, AUTHORIZED_IMAGE_IDLE_REVOKE_MS);
}

function clearIdleAuthorizedImageCacheForOtherAuth(authKey: string): void {
  for (const [key, entry] of authorizedImageCache) {
    if (entry.authKey === authKey || entry.refs > 0) continue;
    // 仍被旧组件引用的 URL 交给 release 流程收尾；这里只清空空闲项，避免用户切换时撤销正在渲染的 src。
    if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    authorizedImageCache.delete(key);
  }
}

function useAuthorizedImageSrc(src: string | undefined): { src: string | undefined; failed: boolean } {
  const shouldAuthorize = useMemo(() => Boolean(src && isPrivateAssetUrl(src)), [src]);
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(() => (src && shouldAuthorize ? undefined : src));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!src) {
      setResolvedSrc(undefined);
      return;
    }
    if (!shouldAuthorize) {
      setResolvedSrc(src);
      return;
    }

    const controller = new AbortController();
    let releaseObjectUrl: (() => void) | undefined;

    setResolvedSrc(undefined);
    void (async () => {
      try {
        const acquired = await acquireAuthorizedImageObjectUrl(src, controller.signal);
        releaseObjectUrl = acquired.release;
        // 用 object URL 交给 <img> 渲染，可以保留浏览器图片解码能力，同时避免把认证 token 暴露在 URL 上。
        setResolvedSrc(acquired.objectUrl);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();

    return () => {
      controller.abort();
      releaseObjectUrl?.();
    };
  }, [shouldAuthorize, src]);

  return { src: resolvedSrc, failed };
}

/** AuthorizedImage 统一处理私有资产鉴权、object URL 生命周期和外链 referrer 策略。 */
export function AuthorizedImage({ src, onError, ...props }: AuthorizedImageProps) {
  const displaySrc = useMemo(() => resolveDisplayLogoSrc(src), [src]);
  const image = useAuthorizedImageSrc(displaySrc);
  const referrerPolicy = props.referrerPolicy ?? (displaySrc && isExternalHttpImageSrc(displaySrc) ? "no-referrer" : undefined);

  useEffect(() => {
    // resolveDisplayLogoSrc 可能因 mixed content/IP host 返回 undefined；调用方应走占位图而不是渲染坏 URL。
    if (!displaySrc || image.failed) onError?.();
  }, [displaySrc, image.failed, onError]);

  if (!image.src) return null;

  return (
    <img
      {...props}
      src={image.src}
      loading={props.loading ?? "lazy"}
      decoding={props.decoding ?? "async"}
      referrerPolicy={referrerPolicy}
      onError={() => {
        onError?.();
      }}
    />
  );
}

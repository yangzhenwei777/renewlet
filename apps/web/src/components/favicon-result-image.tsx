/**
 * 搜索结果图片展示组件。
 *
 * 架构位置：
 * - LogoPicker/IconPicker 的远端图片候选会逐张加载。
 * - 本组件把加载态、骨架屏和失败回调封装起来，避免列表项重复实现。
 */
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AuthorizedImage } from "@/components/authorized-image";

/**
 * 搜索结果里的图片展示（带骨架屏 + 渐入），用于减少“图片逐张加载导致的闪烁/突兀出现”。
 *
 * 说明：
 * - 只负责“显示效果”，不做请求/缓存逻辑
 * - `src` 变化时会自动重置加载状态
 */
export function FaviconResultImage({
  src,
  alt,
  className,
  onError,
}: {
  src: string;
  alt: string;
  className?: string | undefined;
  onError?: (() => void) | undefined;
}) {
  const [loaded, setLoaded] = useState(false);

  // 图片 src 变化时重置：避免复用旧状态导致新图直接显示/不显示骨架屏。
  useEffect(() => {
    setLoaded(false);
  }, [src]);

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {!loaded && <Skeleton className="absolute inset-0" />}
      <AuthorizedImage
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className={cn(
          "relative max-h-full max-w-full object-contain transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
          className,
        )}
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
    </div>
  );
}

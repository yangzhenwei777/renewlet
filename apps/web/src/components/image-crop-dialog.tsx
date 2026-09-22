/**
 * 图片裁剪弹窗（用于上传 Logo/Icon 后做裁剪/缩放/旋转）。
 *
 * 说明：
 * - 使用 `react-image-crop` 实现裁剪框
 * - 输出为 base64 data URL，调用方会先用于预览，再上传并替换成 `/api/app/assets/...`
 * - canvas/FileReader 阶段支持 AbortSignal，避免关闭弹窗后旧任务回写
 *
 * 注意： data URL 体积可能很大，不能直接持久化；上传 hook 会负责替换成资产 URL。
 */

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import {
  ReactCrop,
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PercentCrop,
  type PixelCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { RotateCcw, ZoomIn } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { useDeferredDialogInitialFocus } from '@/hooks/use-deferred-dialog-initial-focus';
import { reportClientError } from "@/lib/report-client-error";

export interface ImageCropDialogProps {
  /** 外层上传 hook 持有 open 状态，用于在关闭时废弃未完成的裁剪链路。 */
  open: boolean;
  /** 关闭动作只改变弹窗状态；裁剪结果必须通过 onCropComplete 显式上抛。 */
  onOpenChange: (open: boolean) => void;
  /** 原始图片通常是 FileReader data URL，不能直接进入持久化字段。 */
  imageSrc: string;
  /** 返回裁剪后的 data URL；调用方负责上传并替换为 `/api/app/assets/{id}`。 */
  onCropComplete: (croppedImage: string) => void;
  /** 可选：裁剪框宽高比（默认 1:1）。 */
  aspectRatio?: number;
  /**
   * 可选：导出图片最大边长（像素）。
   *
   * 说明：
   * - 默认按原图像素导出，可能生成非常大的 PNG
   * - 上传到 PocketBase files 时仍会触发服务端大小限制（默认 2MB）
   * - 这里通过“导出时等比缩放”把输出控制在合理范围内（Logo/Icon 一般 256px 足够清晰）
   */
  maxOutputSize?: number;
}

/** 将裁剪框居中并按指定宽高比初始化。 */
function centerAspectCrop(
  mediaWidth: number,
  mediaHeight: number,
  aspect: number,
) {
  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 90,
      },
      aspect,
      mediaWidth,
      mediaHeight,
    ),
    mediaWidth,
    mediaHeight,
  );
}

/**
 * 将裁剪结果绘制到 canvas 并导出为 data URL。
 *
 * 说明：
 * - crop 的坐标是相对渲染尺寸，需要换算到 naturalWidth/naturalHeight
 * - 支持缩放与旋转
 */
async function getCroppedImg(
  image: HTMLImageElement,
  crop: PixelCrop,
  scale = 1,
  rotate = 0,
  maxOutputSize?: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException('Crop cancelled', 'AbortError');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('No 2d context');
  }

  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;

  // 先按 natural 尺寸计算输出，再按 maxOutputSize 等比缩小，避免 logo/icon 超过上传限制。
  const outputWidth = crop.width * scaleX;
  const outputHeight = crop.height * scaleY;

  const maxSide = Math.max(outputWidth, outputHeight);
  const resizeScale =
    typeof maxOutputSize === "number" && maxOutputSize > 0 && maxSide > maxOutputSize
      ? maxOutputSize / maxSide
      : 1;

  canvas.width = Math.max(1, Math.round(outputWidth * resizeScale));
  canvas.height = Math.max(1, Math.round(outputHeight * resizeScale));

  ctx.imageSmoothingQuality = 'high';

  // 旋转中心使用原图中心，避免裁剪框局部坐标导致旋转后偏移。
  const rotateRads = rotate * (Math.PI / 180);
  const centerX = image.naturalWidth / 2;
  const centerY = image.naturalHeight / 2;

  ctx.save();
  // 先做一次等比缩放，把输出控制在 maxOutputSize 内，避免生成超大图片
  if (resizeScale !== 1) {
    ctx.scale(resizeScale, resizeScale);
  }

  // 旋转/缩放都围绕原图中心执行，避免裁剪框坐标和 natural 像素坐标混用后产生偏移。
  ctx.translate(-crop.x * scaleX, -crop.y * scaleY);

  if (rotate !== 0) {
    ctx.translate(centerX, centerY);
    ctx.rotate(rotateRads);
    ctx.translate(-centerX, -centerY);
  }

  if (scale !== 1) {
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  }

  ctx.drawImage(image, 0, 0);
  ctx.restore();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (signal?.aborted) {
          reject(new DOMException('Crop cancelled', 'AbortError'));
          return;
        }
        if (!blob) {
          reject(new Error('Canvas is empty'));
          return;
        }
        const reader = new FileReader();
        const abortReader = () => reader.abort();
        // canvas.toBlob 本身不可取消；在转 data URL 阶段绑定 signal，至少保证关闭弹窗后不会继续 resolve 旧结果。
        signal?.addEventListener('abort', abortReader, { once: true });
        reader.readAsDataURL(blob);
        reader.onerror = () => {
          signal?.removeEventListener('abort', abortReader);
          reject(reader.error ?? new Error('Failed to read cropped image'));
        };
        reader.onabort = () => {
          signal?.removeEventListener('abort', abortReader);
          reject(new DOMException('Crop cancelled', 'AbortError'));
        };
        reader.onloadend = () => {
          signal?.removeEventListener('abort', abortReader);
          if (signal?.aborted) {
            reject(new DOMException('Crop cancelled', 'AbortError'));
            return;
          }
          resolve(reader.result as string);
        };
      },
      'image/png',
      1
    );
  });
}

/**
 * 渲染图片裁剪弹窗，并把确认结果输出为 data URL。
 *
 * 注意： 确认过程中可能被关闭/卸载，因此用 AbortController 防止旧 canvas/FileReader 回写。
 */
export function ImageCropDialogContent({
  open,
  onOpenChange,
  imageSrc,
  onCropComplete,
  aspectRatio = 1,
  maxOutputSize,
}: ImageCropDialogProps) {
  const { t } = useI18n();
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const cropAbortRef = useRef<AbortController | null>(null);
  const resolveInitialFocus = useCallback(
    () => controlsRef.current?.querySelector<HTMLElement>('[role="slider"]') ?? null,
    [],
  );
  useDeferredDialogInitialFocus(open, true, "image-crop", resolveInitialFocus);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cropAbortRef.current?.abort();
      cropAbortRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (open) return;
    cropAbortRef.current?.abort();
    cropAbortRef.current = null;
  }, [open]);

  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget;
    setCrop(centerAspectCrop(width, height, aspectRatio));
  }, [aspectRatio]);

  const handleConfirm = async () => {
    if (!imgRef.current || !completedCrop) return;

    cropAbortRef.current?.abort();
    const controller = new AbortController();
    cropAbortRef.current = controller;

    try {
      const croppedImage = await getCroppedImg(
        imgRef.current,
        completedCrop,
        scale,
        rotate,
        maxOutputSize,
        controller.signal,
      );
      if (controller.signal.aborted || !mountedRef.current) return;
      onCropComplete(croppedImage);
      onOpenChange(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      reportClientError(error, { source: "image-crop" });
    } finally {
      if (cropAbortRef.current === controller) cropAbortRef.current = null;
    }
  };

  const handleReset = () => {
    setScale(1);
    setRotate(0);
    if (imgRef.current) {
      const { width, height } = imgRef.current;
      setCrop(centerAspectCrop(width, height, aspectRatio));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("media.cropTitle")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("media.cropDescription")}
        </DialogDescription>
      </DialogHeader>

      <div ref={controlsRef} className="grid gap-4">
        <div className="flex justify-center bg-secondary/30 rounded-lg p-4 overflow-hidden">
          <ReactCrop
            {...(crop ? { crop } : {})}
            onChange={(_: PixelCrop, percentCrop: PercentCrop) => setCrop(percentCrop)}
            onComplete={(c: PixelCrop) => setCompletedCrop(c)}
            aspect={aspectRatio}
            circularCrop={false}
            className="max-h-64"
          >
            <img
              ref={imgRef}
              src={imageSrc}
              alt={t("media.cropPreview")}
              style={{
                transform: `scale(${scale}) rotate(${rotate}deg)`,
                maxHeight: '256px',
                objectFit: 'contain',
              }}
              onLoad={onImageLoad}
            />
          </ReactCrop>
        </div>

        <div className="grid gap-4 px-1">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 text-sm">
                <ZoomIn className="w-4 h-4" />
                {t("media.zoom")}
              </Label>
              <span className="text-sm text-muted-foreground">{Math.round(scale * 100)}%</span>
            </div>
            <Slider
              value={[scale]}
              onValueChange={(value) => setScale(value[0] ?? scale)}
              min={0.5}
              max={3}
              step={0.1}
              className="w-full"
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 text-sm">
                <RotateCcw className="w-4 h-4" />
                {t("media.rotate")}
              </Label>
              <span className="text-sm text-muted-foreground">{rotate}°</span>
            </div>
            <Slider
              value={[rotate]}
              onValueChange={(value) => setRotate(value[0] ?? rotate)}
              min={-180}
              max={180}
              step={1}
              className="w-full"
            />
          </div>
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleReset}
          className="border-border"
        >
          {t("media.reset")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          className="border-border"
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          onClick={handleConfirm}
          className="bg-primary text-primary-foreground hover:bg-primary-glow"
        >
          {t("media.confirmCrop")}
        </Button>
      </DialogFooter>
    </>
  );
}

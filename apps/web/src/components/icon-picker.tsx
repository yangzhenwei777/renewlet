/**
 * 图标选择器（用于“支付方式”等配置项的 icon）。
 *
 * 支持：
 * - 通过统一 Logo Resolver 搜索内置品牌图标与网站/Favicon 备用候选
 * - 上传本地图片并裁剪（ImageCropDialog）
 *
 * 注意：
 * - Favicon 备用候选依赖浏览器加载外部资源，网络不通时可能加载失败（UI 有降级处理）
 *
 * 注意： 该组件被 Custom Config 弹窗用于支付方式图标。上传中/失败状态必须传回 controller，
 * 否则配置可能保存临时 data URL 或失效图片。
 */

import { Button } from '@/components/ui/button';
import { DeferredImageCropDialog, preloadImageCropDialog } from '@/components/image-crop-dialog-loader';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Upload, Search, X, Loader2, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FaviconResultImage } from '@/components/favicon-result-image';
import { MediaCandidateSearchPanel } from '@/components/media-candidate-search-panel';
import { IMAGE_UPLOAD_ACCEPT } from '@/lib/upload-constraints';
import { useCroppedImageUpload, type UploadStatus } from '@/hooks/use-cropped-image-upload';
import { useMediaCandidates } from '@/hooks/use-media-candidates';
import { useI18n } from '@/i18n/I18nProvider';

/** 透出上传状态类型，方便配置管理弹窗阻止上传中的保存。 */
export type { UploadStatus };

const SEARCH_POPOVER_CLOSE_RESET_DELAY_MS = 200;

interface IconPickerProps {
  /** 当前选中的图标 URL/dataURL（可选）。 */
  value?: string | undefined;
  /** 图标变更回调（传入 URL/dataURL；传 undefined 表示清空）。 */
  onChange: (icon: string | undefined) => void;
  /**
   * 上传状态变更回调（可选）。
   *
   * 用途：
   * - 外层表单/弹窗在上传未完成时禁用“保存/确认”，彻底杜绝把临时 data URL 写入数据库/配置。
   */
  onUploadStatusChange?: ((status: UploadStatus) => void) | undefined;
  /** 搜索提示：打开弹窗时可自动填入并触发搜索。 */
  searchHint?: string | undefined;
  /** 尺寸：影响按钮与预览大小。 */
  size?: 'sm' | 'md';
}

export function IconPicker({
  value,
  onChange,
  onUploadStatusChange,
  searchHint = '',
  size = 'md',
}: IconPickerProps) {
  const { t } = useI18n();
  const search = useMediaCandidates({
    kind: "icon",
    autoQuery: searchHint,
    limit: 32,
    closeResetDelayMs: SEARCH_POPOVER_CLOSE_RESET_DELAY_MS,
  });

  const {
    fileInputRef,
    cropDialogOpen,
    setCropDialogOpen,
    uploadedImage,
    uploadStatus,
    uploadError,
    previewUrl,
    handleFileUpload,
    handleCropComplete,
    applyValue,
  } = useCroppedImageUpload({
    kind: "icon",
    filename: "icon.png",
    onChange,
    onUploadStatusChange,
  });

  const iconSize = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
  const buttonSize = size === 'sm' ? 'h-6 text-xs px-2' : 'h-7 text-xs px-2';
  const displayedIcon = previewUrl ?? value;

  const handleSearchOpenChange = (nextOpen: boolean) => {
    search.onOpenChange(nextOpen);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "group relative shrink-0 overflow-visible",
            iconSize,
          )}
        >
          <button
            type="button"
            aria-label={displayedIcon ? t("media.changeIcon") : t("media.uploadIcon")}
            className={cn(
              "relative flex items-center justify-center rounded-lg border border-border transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              displayedIcon ? "media-thumbnail-canvas overflow-hidden hover:border-primary" : "bg-secondary/50 hover:bg-secondary/80",
              iconSize,
              uploadStatus === "error" && "ring-1 ring-destructive/40",
            )}
            onClick={() => fileInputRef.current?.click()}
            onFocus={preloadImageCropDialog}
            onPointerEnter={preloadImageCropDialog}
            onTouchStart={preloadImageCropDialog}
          >
            {displayedIcon ? (
              <div className="relative z-10 h-full w-full p-1">
                <FaviconResultImage
                  src={displayedIcon}
                  alt={t("media.icon")}
                  className="media-thumbnail-image"
                  onError={() => applyValue(undefined)}
                />
              </div>
            ) : (
              <ImageIcon className="w-4 h-4 text-muted-foreground/50" />
            )}
            {uploadStatus === "uploading" && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            )}
          </button>
          {displayedIcon ? (
            <button
              type="button"
              aria-label={t("media.clearIcon")}
              onClick={() => applyValue(undefined)}
              className="absolute -right-1 -top-1 z-20 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-100 shadow-sm transition-opacity hover:bg-destructive/90 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:opacity-0 sm:group-hover:opacity-100"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("gap-1", buttonSize)}
              onClick={() => fileInputRef.current?.click()}
              onFocus={preloadImageCropDialog}
              onPointerEnter={preloadImageCropDialog}
              onTouchStart={preloadImageCropDialog}
            >
              {uploadStatus === "uploading" ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Upload className="w-3 h-3" />
              )}
              {t("media.upload")}
            </Button>

            <Popover open={search.open} onOpenChange={handleSearchOpenChange}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("gap-1", buttonSize)}
              >
                <Search className="w-3 h-3" />
                {t("media.search")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="media-candidate-popover media-candidate-popover-icon w-72 border-border bg-card p-3 z-50" align="start" sideOffset={8}>
              <div className="media-candidate-popover-panel gap-3">
                <MediaCandidateSearchPanel
                  search={search}
                  title={t("media.searchIcon")}
                  placeholder={t("media.searchIconPlaceholder")}
                  prompt={t("media.searchIconPrompt")}
                  notFoundLabel={t("media.iconNotFound")}
                  selectedValue={value}
                  onClose={() => handleSearchOpenChange(false)}
                  onSelect={(candidate) => {
                    applyValue(candidate.url);
                    handleSearchOpenChange(false);
                  }}
                  size="sm"
                  columnsClassName="grid-cols-4 gap-1.5"
                  inputClassName="h-8 text-sm"
                  searchButtonClassName="h-8"
                />

                {uploadStatus === "error" && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <p className="text-xs text-destructive">
                      {uploadError ?? t("media.iconUploadFailed")}
                    </p>
                  </div>
                )}
              </div>
            </PopoverContent>
            </Popover>
          </div>
          {uploadStatus === "error" && (
            <p className="max-w-48 text-xs text-destructive">
              {uploadError ?? t("media.iconUploadFailed")}
            </p>
          )}
        </div>
      </div>

      <DeferredImageCropDialog
        open={cropDialogOpen}
        onOpenChange={setCropDialogOpen}
        imageSrc={uploadedImage}
        onCropComplete={handleCropComplete}
        aspectRatio={1}
        // Icon 在 UI 中展示尺寸很小，限制最大导出尺寸可避免生成超大图片导致上传失败
        maxOutputSize={256}
      />
    </>
  );
}

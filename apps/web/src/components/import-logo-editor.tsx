import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Image as ImageIcon, ImageOff, Images, Link, Loader2, RefreshCw, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MediaCandidateSearchPanel } from "@/components/media-candidate-search-panel";
import { MediaCandidateViewport } from "@/components/media-candidate-viewport";
import { MediaThumbnailButton } from "@/components/media-thumbnail-button";
import { LogoUrlInputPanel } from "@/components/logo-url-input-panel";
import { SubscriptionLogo } from "@/components/subscription-logo";
import {
  DeferredImageCropDialog,
  preloadImageCropDialog,
} from "@/components/image-crop-dialog-loader";
import { useMediaCandidates } from "@/hooks/use-media-candidates";
import { useUploadedLogoAssets } from "@/hooks/use-uploaded-logo-assets";
import { dataUrlToBlob, validateImageFileForUpload } from "@/lib/upload-image";
import { IMAGE_UPLOAD_ACCEPT, imageExtensionForMime, isIcoImageMime, isSvgImageMime, uploadMimeTypeForFile } from "@/lib/upload-constraints";
import { useI18n } from "@/i18n/I18nProvider";

export interface DeferredLogoAsset {
  /** 待导入订阅最终保存前才上传，避免用户取消导入后留下孤立私有资产。 */
  blob: Blob;
  /** 导入确认时传给资产服务的文件名；真实对象路径仍由后端生成。 */
  filename: string;
  /** 本地预览 URL，只能停留在导入草稿态，不能写进订阅持久化字段。 */
  previewUrl: string;
}

interface ImportLogoEditorProps {
  /** 导入行的服务名，同时作为首次搜索的 autoQuery。 */
  name: string;
  /** 导入行的网站 URL；手动修正 Logo 时优先生成对应域名的 favicon 备用候选。 */
  website?: string | null | undefined;
  /** 当前远端/私有资产 Logo URL；选择本地草稿资产时会临时为空。 */
  value?: string | null | undefined;
  /** 已 staged 本地资产的预览 URL，由导入控制器持有，避免弹层重开时丢失预览。 */
  assetPreviewUrl?: string | undefined;
  /** 输出远端 URL 或 deferred asset；真正上传发生在导入提交阶段。 */
  onChange: (value: string | null, asset?: DeferredLogoAsset) => void;
}

/**
 * ImportLogoEditor 为导入预览行提供 Logo 修正能力。
 *
 * 与普通 LogoPicker 不同，这里不能立即上传本地文件：导入批量确认前用户可能撤销整批数据，
 * 所以组件只 stage Blob 与预览，最终由导入流程统一落库。
 */
export function ImportLogoEditor({ name, website, value, assetPreviewUrl, onChange }: ImportLogoEditorProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadedLogos = useUploadedLogoAssets();
  const [open, setOpen] = useState(false);
  const [uploadedImage, setUploadedImage] = useState("");
  const [cropDialogOpen, setCropDialogOpen] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | undefined>();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const search = useMediaCandidates({
    kind: "logo",
    autoQuery: name,
    website: website ?? undefined,
    limit: 32,
    closeResetDelayMs: 160,
  });
  const displayedLogo = localPreview ?? assetPreviewUrl ?? value ?? undefined;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    search.onOpenChange(nextOpen);
    if (nextOpen) {
      setUploadError(null);
      // 已上传资产只在用户展开编辑器时懒加载，避免导入列表每一行都打一次私有资产 API。
      void uploadedLogos.loadInitial();
      return;
    }
    uploadedLogos.reset();
  };

  const chooseRemote = (url: string | undefined) => {
    setLocalPreview(undefined);
    setUploadError(null);
    onChange(url ?? null);
    handleOpenChange(false);
  };

  const stageBlob = (blob: Blob, filename: string, previewUrl: string) => {
    setLocalPreview(previewUrl);
    setUploadError(null);
    // 本地文件先作为 deferred asset 上抛；URL 写 null 是为了防止 data URL 被误当成已持久化 Logo。
    onChange(null, { blob, filename, previewUrl });
    handleOpenChange(false);
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const validationError = validateImageFileForUpload(file);
    if (validationError) {
      setUploadError(validationError);
      return;
    }
    const mimeType = uploadMimeTypeForFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      if (isSvgImageMime(mimeType) || isIcoImageMime(mimeType)) {
        // SVG/ICO 保留原始文件，避免导入页裁剪把矢量/多尺寸资源降级成单张 PNG。
        stageBlob(file, normalizedFilename(file.name, mimeType), result);
        return;
      }
      setUploadedImage(result);
      setCropDialogOpen(true);
    };
    reader.onerror = () => setUploadError(t("media.readImageFailed"));
    reader.readAsDataURL(file);
  };

  const handleCropComplete = async (croppedImage: string) => {
    try {
      const blob = dataUrlToBlob(croppedImage);
      stageBlob(blob, `import-logo.${imageExtensionForMime(blob.type) ?? "png"}`, croppedImage);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t("media.logoUploadFailed"));
    } finally {
      setUploadedImage("");
      setCropDialogOpen(false);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-9 gap-2 border-border px-2" aria-label={t("import.logoEdit")}>
            <LogoThumb src={displayedLogo} name={name} />
            <span className="hidden sm:inline">{t("import.logoEdit")}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="media-candidate-popover media-candidate-popover-import h5-logo-sheet h5-import-logo-sheet w-96 border-border bg-card p-4"
          align="center"
          side="left"
          sideOffset={8}
          mobileDetent="large"
          mobileTitle={t("import.logoEditTitle")}
          mobileDescription={name}
          data-testid="import-logo-sheet"
        >
          <div className="media-candidate-popover-panel h5-import-logo-panel gap-4">
            <div className="flex items-center gap-3">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border bg-secondary/50 p-1">
                <LogoThumb src={displayedLogo} name={name} className="h-full w-full" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("import.logoPreviewHint")}</p>
              </div>
              {displayedLogo ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => chooseRemote(undefined)} aria-label={t("import.logoClear")}>
                      <ImageOff className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="center" className="text-xs">
                    {t("import.logoClear")}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            <input ref={fileInputRef} type="file" accept={IMAGE_UPLOAD_ACCEPT} className="hidden" onChange={handleFileUpload} />
            <div className="grid gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2 border-border"
                onFocus={preloadImageCropDialog}
                onPointerEnter={preloadImageCropDialog}
                onTouchStart={preloadImageCropDialog}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                {t("media.uploadLogo")}
              </Button>
            </div>
            {uploadError ? <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{uploadError}</p> : null}

            <Tabs defaultValue="search" className="media-candidate-tabs h5-import-logo-tabs min-h-0">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="search" className="gap-1.5">
                  <Search className="h-3.5 w-3.5" />
                  {t("media.search")}
                </TabsTrigger>
                <TabsTrigger value="uploaded" className="gap-1.5">
                  <Images className="h-3.5 w-3.5" />
                  {t("media.uploaded")}
                </TabsTrigger>
                <TabsTrigger value="link" className="gap-1.5">
                  <Link className="h-3.5 w-3.5" />
                  {t("media.link")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="search" className="media-candidate-tab-content mt-3">
                <MediaCandidateSearchPanel
                  search={search}
                  placeholder={t("media.searchLogoPlaceholder")}
                  prompt={t("media.searchLogoPrompt")}
                  notFoundLabel={t("media.logoNotFound")}
                  selectedValue={value}
                  size="sm"
                  columnsClassName="grid-cols-5"
                  panelClassName="gap-3"
                  inputRowClassName="h5-logo-search-input-row"
                  searchButtonClassName="h-9"
                  resultsClassName="h5-logo-sheet-results h5-import-logo-results"
                  dataTestId="import-logo-search-results"
                  onSelect={(candidate) => chooseRemote(candidate.url)}
                />
              </TabsContent>

              <TabsContent value="uploaded" className="media-candidate-tab-content mt-3">
                <MediaCandidateViewport
                  className="h5-logo-sheet-results h5-import-logo-results"
                  dataTestId="import-uploaded-logo-results"
                >
                  {uploadedLogos.isLoading && uploadedLogos.assets.length === 0 ? <InlineLoading label={t("media.loadingUploadedLogo")} /> : null}
                  {uploadedLogos.error && uploadedLogos.assets.length === 0 ? (
                    <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
                      <p className="text-xs text-destructive">{t("media.uploadedLogoLoadFailed")}</p>
                      <Button type="button" variant="outline" size="sm" className="gap-2 border-border" onClick={() => void uploadedLogos.loadInitial()}>
                        <RefreshCw className="h-4 w-4" />
                        {t("media.retryUploadedLogo")}
                      </Button>
                    </div>
                  ) : null}
                  {uploadedLogos.assets.length > 0 ? (
                    <LogoGrid empty={t("media.noUploadedLogo")}>
                      {uploadedLogos.assets.map((asset, index) => {
                        const label = asset.originalName ?? t("media.uploadedLogoOption", { index: index + 1 });
                        return <MediaThumbnailButton key={asset.id} src={asset.url} alt={label} tooltip={label} selected={value === asset.url} onClick={() => chooseRemote(asset.url)} size="sm" />;
                      })}
                    </LogoGrid>
                  ) : !uploadedLogos.isLoading && !uploadedLogos.error && uploadedLogos.hasLoaded ? (
                    <EmptyLogoState label={t("media.noUploadedLogo")} icon="uploaded" />
                  ) : null}
                  {uploadedLogos.hasMore ? (
                    <Button type="button" variant="outline" size="sm" className="gap-2 border-border" onClick={() => void uploadedLogos.loadMore()} disabled={uploadedLogos.isLoadingMore}>
                      {uploadedLogos.isLoadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <Images className="h-4 w-4" />}
                      {t("media.loadMoreUploadedLogo")}
                    </Button>
                  ) : null}
                </MediaCandidateViewport>
              </TabsContent>

              <TabsContent value="link" className="media-candidate-tab-content mt-3">
                <LogoUrlInputPanel
                  value={value}
                  size="sm"
                  className="h5-logo-link-panel"
                  onApply={(url) => chooseRemote(url)}
                />
              </TabsContent>
            </Tabs>
          </div>
        </PopoverContent>
      </Popover>

      <DeferredImageCropDialog
        open={cropDialogOpen}
        onOpenChange={setCropDialogOpen}
        imageSrc={uploadedImage}
        onCropComplete={(croppedImage) => void handleCropComplete(croppedImage)}
        aspectRatio={1}
        maxOutputSize={256}
      />
    </>
  );
}

function LogoThumb({ src, name, className }: { src?: string | undefined; name: string; className?: string | undefined }) {
  return <SubscriptionLogo name={name} logo={src} size="xs" className={className} />;
}

function LogoGrid({ children, empty }: { children: ReactNode; empty: string }) {
  const hasChildren = Boolean(children) && (!Array.isArray(children) || children.length > 0);
  if (!hasChildren) return <EmptyLogoState label={empty} />;
  return <div className="grid grid-cols-5 gap-2 p-1">{children}</div>;
}

function EmptyLogoState({ label, icon = "image" }: { label: string; icon?: "image" | "uploaded" }) {
  const Icon = icon === "uploaded" ? Images : ImageIcon;
  return (
    <div className="media-candidate-message rounded-md border border-dashed border-border bg-secondary/30 px-3 py-4 text-center">
      <Icon className="mx-auto h-7 w-7 text-muted-foreground/50" />
      <p className="mt-2 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function InlineLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      {label}
    </div>
  );
}

function normalizedFilename(name: string, mimeType: string): string {
  const extension = imageExtensionForMime(mimeType) ?? "png";
  const base = name.trim().replace(/\.[^.]+$/, "") || "import-logo";
  return `${base}.${extension}`;
}

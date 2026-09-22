import * as React from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TruncatedTooltipText } from "@/components/ui/truncated-tooltip-text";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import type { AiModelListItem, AiRecognitionModelInputMode } from "@/lib/api/schemas/ai-recognition";

type AIModelComboboxStatus = "idle" | "loading" | "success" | "error";

interface AIModelComboboxProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  mode: AiRecognitionModelInputMode;
  models: AiModelListItem[];
  status: AIModelComboboxStatus;
  error: string | null;
  truncated: boolean;
  canAutoRefreshModels?: boolean;
  onRequestModels: () => void;
  disabled?: boolean;
  placeholder?: string;
}

const MODEL_INITIAL_RENDER_LIMIT = 120;

// AI 模型列表来自后端代理的第三方 /models；组件只管理选择体验，不把 API key 暴露给浏览器直连。
export function AIModelCombobox({
  id,
  value,
  onValueChange,
  mode,
  models,
  status,
  error,
  truncated,
  canAutoRefreshModels = false,
  onRequestModels,
  disabled = false,
  placeholder,
}: AIModelComboboxProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const previousStatusRef = React.useRef<AIModelComboboxStatus>(status);
  const selectedModel = React.useMemo(
    () => models.find((model) => sameModelId(model.id, value)) ?? null,
    [models, value],
  );
  const visibleModels = React.useMemo(() => {
    const query = modelSearchKey(search);
    if (query) return models.filter((model) => modelMatchesQuery(model, query));
    // 第三方模型列表可能很长，初始只渲染前 N 个；搜索时再展开匹配结果，保护设置页弹层性能。
    return models.slice(0, MODEL_INITIAL_RENDER_LIMIT);
  }, [models, search]);
  const showModelListFeedback = mode === "select";

  React.useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    // 用户显式刷新成功后自动展开列表，让“刷新模型 -> 选择模型”保持在同一交互上下文里。
    if (previousStatus === "loading" && status === "success" && models.length > 0 && mode === "select") {
      setOpen(true);
    }
  }, [mode, models.length, status]);

  React.useEffect(() => {
    // 关闭 popover 时丢弃搜索词，避免下一次打开看不到刚刷新出来的 provider 模型。
    if (!open) setSearch("");
  }, [open]);

  React.useEffect(() => {
    // 手动输入和错误态都不展示旧列表，避免用户误选到已失败 provider 返回的过期候选。
    if (disabled || status === "error" || mode === "manual") setOpen(false);
  }, [disabled, mode, status]);

  const handleSelectModel = React.useCallback((modelId: string) => {
    onValueChange(modelId);
    setOpen(false);
  }, [onValueChange]);

  const requestModelsIfNeeded = React.useCallback(() => {
    if (!canAutoRefreshModels || disabled || status === "loading") return;
    // 只在 idle/error 时触发代理刷新；success 结果由 React Query/上层缓存控制新鲜度。
    if (status === "idle" || status === "error") onRequestModels();
  }, [canAutoRefreshModels, disabled, onRequestModels, status]);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) requestModelsIfNeeded();
  }, [requestModelsIfNeeded]);

  return (
    <div className="grid gap-2">
      <div className="min-w-0">
        {mode === "manual" ? (
          <Input
            id={id}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            disabled={disabled}
            aria-label={t("aiRecognition.model")}
            placeholder={placeholder || t("aiRecognition.modelPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            className="w-full min-w-0 border-border bg-secondary text-sm"
          />
        ) : (
          <Popover modal open={open && !disabled} onOpenChange={handleOpenChange}>
            <PopoverTrigger asChild>
              <Button
                id={id}
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={open && !disabled}
                aria-label={t("aiRecognition.model")}
                disabled={disabled}
                className={cn(
                  "w-full min-w-0 justify-between border-border bg-secondary px-3 font-normal text-foreground hover:bg-secondary/80",
                  !value.trim() && "text-muted-foreground",
                )}
              >
                <span className="min-w-0 flex-1 text-left">
                  <TruncatedTooltipText
                    text={selectedModel?.displayName || value.trim() || t("aiRecognition.modelSelectPlaceholder")}
                    className="min-w-0"
                  />
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              aria-label={t("aiRecognition.model")}
              data-testid="ai-model-combobox-popover"
              mobilePresentation="anchored"
              mobileKind="list"
              className="w-(--radix-popover-trigger-width) min-w-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground"
            >
              <Command shouldFilter={false} loop className="flex max-h-96 w-full flex-col bg-popover text-popover-foreground">
                <div className="flex items-center border-b border-border px-3">
                  <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <Command.Input
                    value={search}
                    onValueChange={setSearch}
                    placeholder={t("aiRecognition.modelSelectSearchPlaceholder")}
                    className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <Command.List className="max-h-80 overflow-y-auto p-1">
                  {status === "loading" ? (
                    <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("aiRecognition.modelListLoading")}
                    </div>
                  ) : null}

                  {status !== "loading" && visibleModels.length > 0 ? (
                    visibleModels.map((model) => (
                      <AIModelOptionItem
                        key={model.id}
                        model={model}
                        selected={sameModelId(model.id, value)}
                        onSelect={() => handleSelectModel(model.id)}
                      />
                    ))
                  ) : null}

                  {status !== "loading" && visibleModels.length === 0 ? (
                    <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {t("aiRecognition.modelSelectEmpty")}
                    </div>
                  ) : null}
                </Command.List>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {showModelListFeedback && error ? <p className="text-xs leading-5 text-destructive">{error}</p> : null}
      {showModelListFeedback && status === "success" && truncated ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("aiRecognition.modelListTruncated")}</p>
      ) : null}
    </div>
  );
}

export function AIModelModeSwitch({
  disabled = false,
  mode,
  onModeChange,
}: {
  disabled?: boolean;
  mode: AiRecognitionModelInputMode;
  onModeChange: (mode: AiRecognitionModelInputMode) => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-secondary/30 p-0.5 text-xs"
      role="group"
      aria-label={t("aiRecognition.modelMode")}
      data-testid="ai-model-mode-switch"
    >
      <AIModelModeButton
        active={mode === "select"}
        disabled={disabled}
        onClick={() => onModeChange("select")}
      >
        {t("aiRecognition.modelModeSelect")}
      </AIModelModeButton>
      <AIModelModeButton
        active={mode === "manual"}
        disabled={disabled}
        onClick={() => onModeChange("manual")}
      >
        {t("aiRecognition.modelModeManual")}
      </AIModelModeButton>
    </div>
  );
}

function AIModelModeButton({
  active,
  children,
  disabled,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center rounded-[5px] px-2 text-xs font-medium text-muted-foreground transition-colors",
        "hover:bg-secondary/60 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        active && "bg-secondary text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function AIModelOptionItem({
  model,
  selected,
  onSelect,
}: {
  model: AiModelListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={model.id}
      keywords={[model.id, model.displayName ?? "", model.ownedBy ?? ""].filter(Boolean)}
      aria-current={selected ? "true" : undefined}
      onSelect={onSelect}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-sm py-2 pl-8 pr-2 text-sm outline-none transition-colors",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
      )}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        {selected ? <Check className="h-4 w-4" /> : null}
      </span>
      <TruncatedTooltipText text={model.displayName || model.id} className="min-w-0 flex-1" />
    </Command.Item>
  );
}

function sameModelId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function modelSearchKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function modelMatchesQuery(model: AiModelListItem, query: string): boolean {
  return [
    model.id,
    model.displayName ?? "",
    model.ownedBy ?? "",
  ].some((value) => modelSearchKey(value).includes(query));
}

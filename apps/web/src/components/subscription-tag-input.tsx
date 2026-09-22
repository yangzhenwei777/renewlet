/**
 * 订阅标签输入。
 *
 * 架构位置：
 * - SubscriptionFormFields 负责表单布局，本组件只管理标签数组的输入体验。
 * - 标签最终契约仍由 subscription-form / 后端 hook 校验，避免 UI 成为唯一防线。
 *
 * 注意： 标签按精确文本去重，不做大小写折叠；这与后端 normalizeTags 保持一致。
 */
import * as React from "react";
import { Plus, Tag, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  MAX_SUBSCRIPTION_TAG_LENGTH,
  MAX_SUBSCRIPTION_TAGS,
} from "@/types/subscription";
import { normalizeTagsArray, parseTagsInput } from "@/lib/subscription-form";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nProvider";

interface SubscriptionTagInputProps {
  id: string;
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: readonly string[];
  error?: string | undefined;
  errorId?: string | undefined;
  onClearError?: (() => void) | undefined;
}

const separatorKeySet = new Set([",", "，", "、", ";", "；"]);

type TagOption = {
  kind: "suggestion" | "create";
  value: string;
};

function tagLength(tag: string) {
  return Array.from(tag).length;
}

export function SubscriptionTagInput({
  id,
  value,
  onChange,
  suggestions = [],
  error,
  errorId,
  onClearError,
}: SubscriptionTagInputProps) {
  const { t } = useI18n();
  const fieldRef = React.useRef<HTMLDivElement | null>(null);
  const popoverContentRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const listboxId = `${id}-tag-listbox`;
  const normalizedValue = React.useMemo(() => normalizeTagsArray(value), [value]);
  const normalizedSuggestions = React.useMemo(() => normalizeTagsArray(suggestions), [suggestions]);
  const selectedSet = new Set(normalizedValue);
  const trimmedInput = inputValue.trim();
  const lowerInput = trimmedInput.toLowerCase();
  const visibleSuggestions = normalizedSuggestions.filter((tag) => {
    if (selectedSet.has(tag)) return false;
    if (!lowerInput) return true;
    return tag.toLowerCase().includes(lowerInput);
  });
  const canCreate =
    trimmedInput.length > 0 &&
    !selectedSet.has(trimmedInput) &&
    !normalizedSuggestions.includes(trimmedInput);
  const suggestionOptions = visibleSuggestions.map<TagOption>((tag) => ({ kind: "suggestion", value: tag }));
  const options: TagOption[] = canCreate
    ? [...suggestionOptions, { kind: "create", value: trimmedInput }]
    : suggestionOptions;
  const effectiveError = error ?? localError ?? undefined;
  const resolvedErrorId = errorId ?? `${id}-error`;
  const activeOptionId =
    open && activeIndex !== null && options[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined;
  const hasTags = normalizedValue.length > 0;
  const placeholder = t("subscription.placeholder.tags");
  const sizerText = hasTags ? inputValue || "\u00a0" : inputValue || placeholder;
  const inputSizerClassName = cn(
    "inline-grid max-w-full",
    // 空光标没有真实文本撑宽；压到 1px 避免 flex 换行用 input 默认 intrinsic width 误判。
    hasTags ? (inputValue ? "min-w-[1ch] flex-none" : "min-w-px w-px flex-none") : "min-w-32 flex-1",
  );
  const inputClassName =
    "col-start-1 row-start-1 h-7 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50";

  const isInsideTagComposite = React.useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) return false;
    return Boolean(fieldRef.current?.contains(target) || popoverContentRef.current?.contains(target));
  }, []);

  React.useEffect(() => {
    setActiveIndex((current) => {
      if (current === null) return null;
      return current < options.length ? current : null;
    });
  }, [options.length]);

  const updateTags = React.useCallback((nextTags: string[]) => {
    onChange(nextTags);
    setLocalError(null);
    onClearError?.();
  }, [onChange, onClearError]);

  const appendTags = React.useCallback((rawTags: readonly string[], options: { refocus?: boolean } = {}) => {
    const incoming = normalizeTagsArray(rawTags);
    if (incoming.length === 0) return false;

    if (incoming.some((tag) => tagLength(tag) > MAX_SUBSCRIPTION_TAG_LENGTH)) {
      setLocalError(t("subscription.validation.tagTooLong", { count: MAX_SUBSCRIPTION_TAG_LENGTH }));
      return false;
    }

    const merged = normalizeTagsArray([...normalizedValue, ...incoming]);
    if (merged.length > MAX_SUBSCRIPTION_TAGS) {
      updateTags(merged.slice(0, MAX_SUBSCRIPTION_TAGS));
      setLocalError(t("subscription.validation.tagsTooMany", { count: MAX_SUBSCRIPTION_TAGS }));
      return false;
    }

    updateTags(merged);
    setInputValue("");
    setActiveIndex(null);
    if (options.refocus ?? true) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    return true;
  }, [normalizedValue, t, updateTags]);

  const commitInputValue = React.useCallback((rawValue = inputValue) => {
    const parsed = parseTagsInput(rawValue);
    if (parsed.length === 0) {
      setInputValue("");
      return false;
    }
    return appendTags(parsed, { refocus: false });
  }, [appendTags, inputValue]);

  const removeTag = React.useCallback((tagToRemove: string) => {
    updateTags(normalizedValue.filter((tag) => tag !== tagToRemove));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [normalizedValue, updateTags]);

  const handleInputChange = (nextValue: string) => {
    setLocalError(null);
    setActiveIndex(null);
    if (/[、，,;；\n]/.test(nextValue)) {
      const parsed = parseTagsInput(nextValue);
      if (parsed.length === 0) {
        setInputValue("");
        return;
      }
      if (!appendTags(parsed)) setInputValue(nextValue);
      return;
    }
    setInputValue(nextValue);
    setOpen(true);
  };

  const handleInputEvent = (event: React.ChangeEvent<HTMLInputElement>) => {
    handleInputChange(event.target.value);
  };

  const handleInputBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (isInsideTagComposite(event.relatedTarget)) return;
    // 直接填完标签后切日期或点保存不会触发 Enter；离开复合输入时提交 pending 文本，避免 UI 态标签丢失。
    commitInputValue(event.currentTarget.value);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const currentValue = event.currentTarget.value;

    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(null);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => {
        if (current === null) return event.key === "ArrowDown" ? 0 : options.length - 1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        return (current + delta + options.length) % options.length;
      });
      return;
    }

    if (event.key === "Backspace" && currentValue.length === 0 && normalizedValue.length > 0) {
      event.preventDefault();
      const lastTag = normalizedValue[normalizedValue.length - 1];
      if (lastTag) removeTag(lastTag);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const activeOption = activeIndex === null ? undefined : options[activeIndex];
      if (activeOption) {
        handleSelectOption(activeOption);
        return;
      }
      appendTags([currentValue]);
      return;
    }

    if (separatorKeySet.has(event.key)) {
      event.preventDefault();
      appendTags([currentValue]);
    }
  };

  const handleSelectOption = (option: TagOption) => {
    appendTags([option.value]);
    setOpen(true);
  };

  return (
    <Popover modal={false} open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setActiveIndex(null);
    }}>
      <FormField id={id} error={effectiveError} errorId={resolvedErrorId}>
        {(field) => (
          <>
        <PopoverAnchor asChild>
          <div
            ref={fieldRef}
            data-slot="subscription-tag-field"
            className={cn(
              "flex min-h-10 w-full flex-wrap items-center gap-2 rounded-md border border-input bg-secondary px-2 py-1.5 text-sm ring-offset-background transition-colors",
              "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
              effectiveError && "border-destructive focus-within:ring-destructive/40",
            )}
            onClick={() => {
              inputRef.current?.focus();
              setOpen(true);
            }}
          >
            {normalizedValue.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="max-w-full shrink-0 gap-1 border-border bg-background/60 px-2 py-1 text-foreground"
              >
                <span className="max-w-48 truncate">{tag}</span>
                <button
                  type="button"
                  className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  aria-label={t("subscription.tags.remove", { tag })}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeTag(tag);
                  }}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </Badge>
            ))}
            <span data-slot="subscription-tag-input-sizer" className={inputSizerClassName}>
              <span
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 h-7 whitespace-pre text-sm"
              >
                {sizerText}
              </span>
              <input
                ref={inputRef}
                id={field.id}
                name={field.id}
                data-subscription-tag-pending-input=""
                size={1}
                value={inputValue}
                onChange={handleInputEvent}
                onKeyDown={handleKeyDown}
                onBlur={handleInputBlur}
                onFocus={() => setOpen(true)}
                placeholder={hasTags ? "" : placeholder}
                enterKeyHint="done"
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
                aria-controls={open ? listboxId : undefined}
                aria-activedescendant={activeOptionId}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className={inputClassName}
              />
            </span>
          </div>
        </PopoverAnchor>

        <PopoverContent
          ref={popoverContentRef}
          data-testid="subscription-tag-popover"
          role="presentation"
          mobilePresentation="anchored"
          side="top"
          align="start"
          sideOffset={6}
          avoidCollisions={false}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => {
            if (isInsideTagComposite(event.target)) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isInsideTagComposite(event.target)) event.preventDefault();
          }}
          className="w-(--radix-popover-trigger-width) overflow-hidden border-border bg-popover p-0 text-popover-foreground"
        >
          <div id={listboxId} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {options.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {t("subscription.tags.empty")}
              </div>
            ) : (
              options.map((option, index) => {
                const active = activeIndex === index;
                const optionId = `${listboxId}-option-${index}`;
                return (
                  <div
                    key={`${option.kind}-${option.value}`}
                    id={optionId}
                    role="option"
                    aria-selected={active}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => handleSelectOption(option)}
                    className={cn(
                      "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none transition-colors",
                      active && "bg-accent text-accent-foreground",
                    )}
                  >
                    {option.kind === "create" ? (
                      <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <Tag className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {option.kind === "create"
                        ? t("subscription.tags.create", { tag: option.value })
                        : option.value}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
          </>
        )}
      </FormField>
    </Popover>
  );
}

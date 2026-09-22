/**
 * 本地时间选择器（TimePicker）。
 *
 * 架构位置：用于通知设置中的本地提醒时间，输出 `HH:mm` 字符串给 settings schema。
 *
 * 注意： 这里不处理时区；调度器会在后端把 `HH:mm + IANA timezone` 转为 UTC instant。
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n/I18nProvider';
import { useAppRootScrollLock } from '@/hooks/use-app-root-scroll-lock';

interface TimePickerProps {
  id?: string;
  /** `HH:mm` 本地墙钟时间；必须与 settings.timeZone 一起解释为 UTC instant。 */
  value: string;
  /** 输出仍为 `HH:mm`，组件不做时区换算。 */
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaDescribedBy?: string | undefined;
  density?: 'default' | 'compact';
}

const ITEM_HEIGHT = 40;
const VISIBLE_ITEMS = 5;
const PADDING_ITEMS = Math.floor(VISIBLE_ITEMS / 2);
const DRAG_THRESHOLD_PX = 4;
const SCROLL_END_DEBOUNCE_MS = 120;
const WHEEL_LINE_HEIGHT_PX = 16;
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => i);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function scrollToTop(element: HTMLDivElement, top: number) {
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top });
    return;
  }

  element.scrollTop = top;
}

function formatTimePart(value: number) {
  return value.toString().padStart(2, '0');
}

function parseTimePart(value: string | undefined, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : 0;
}

function normalizeWheelDelta(delta: number, deltaMode: number, viewportHeight: number) {
  switch (deltaMode) {
    case 1:
      return delta * WHEEL_LINE_HEIGHT_PX;
    case 2:
      return delta * viewportHeight;
    default:
      return delta;
  }
}

function WheelColumn({ 
  options, 
  value, 
  onChange,
  label,
  ariaLabel,
}: { 
  options: number[]; 
  value: number; 
  onChange: (val: number) => void;
  label: string;
  ariaLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const dragStateRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [displayValue, setDisplayValue] = useState(value);
  const [isDragging, setIsDragging] = useState(false);

  const getIndexForValue = useCallback((nextValue: number) => {
    const index = options.indexOf(nextValue);
    return index === -1 ? 0 : index;
  }, [options]);

  const getNearestIndex = useCallback((scrollTop: number) => {
    return clamp(Math.round(scrollTop / ITEM_HEIGHT), 0, options.length - 1);
  }, [options.length]);

  const clearScrollEndTimer = useCallback(() => {
    if (scrollEndTimerRef.current) {
      clearTimeout(scrollEndTimerRef.current);
      scrollEndTimerRef.current = null;
    }
  }, []);

  const commitValue = useCallback((nextValue: number) => {
    const container = containerRef.current;
    const index = getIndexForValue(nextValue);

    setDisplayValue(nextValue);
    if (container) {
      scrollToTop(container, index * ITEM_HEIGHT);
    }

    if (nextValue !== valueRef.current) {
      valueRef.current = nextValue;
      onChangeRef.current(nextValue);
    }
  }, [getIndexForValue]);

  const updateDisplayFromScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const index = getNearestIndex(container.scrollTop);
    setDisplayValue(options[index] ?? valueRef.current);
  }, [getNearestIndex, options]);

  const snapToNearest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const index = getNearestIndex(container.scrollTop);
    commitValue(options[index] ?? valueRef.current);
  }, [commitValue, getNearestIndex, options]);

  const scheduleScrollEndSnap = useCallback(() => {
    clearScrollEndTimer();
    // Safari/WebView 仍可能没有可靠 scrollend，保留 debounce 兜底保证滚轮最终吸附到合法项。
    scrollEndTimerRef.current = setTimeout(() => {
      scrollEndTimerRef.current = null;
      snapToNearest();
    }, SCROLL_END_DEBOUNCE_MS);
  }, [clearScrollEndTimer, snapToNearest]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    valueRef.current = value;
    setDisplayValue(value);

    if (containerRef.current) {
      scrollToTop(containerRef.current, getIndexForValue(value) * ITEM_HEIGHT);
    }
  }, [getIndexForValue, value]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScrollEnd = () => {
      if (dragStateRef.current) return;
      // 原生 scrollend 可用时立即吸附；拖拽中跳过，避免 pointer move 期间被浏览器滚动事件打断。
      clearScrollEndTimer();
      snapToNearest();
    };

    container.addEventListener('scrollend', handleScrollEnd);
    return () => {
      container.removeEventListener('scrollend', handleScrollEnd);
    };
  }, [clearScrollEndTimer, snapToNearest]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;

      const viewportHeight = container.clientHeight || ITEM_HEIGHT * VISIBLE_ITEMS;
      const deltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, viewportHeight);
      const deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, viewportHeight);

      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        // 桌面触摸板会给纵向轮盘带横向 wheel；只吞横向主导输入，避免破坏原生纵向滚动手感。
        event.preventDefault();
        container.scrollLeft = 0;
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => clearScrollEndTimer, [clearScrollEndTimer]);

  const handleScroll = useCallback(() => {
    updateDisplayFromScroll();
    if (!dragStateRef.current) {
      scheduleScrollEndSnap();
    }
  }, [scheduleScrollEndSnap, updateDisplayFromScroll]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.button !== 0) return;

    clearScrollEndTimer();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: event.currentTarget.scrollTop,
      moved: false,
    };
    setIsDragging(true);

    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }, [clearScrollEndTimer]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    const container = containerRef.current;
    if (!dragState || !container || dragState.pointerId !== event.pointerId) return;

    const deltaY = event.clientY - dragState.startY;
    if (!dragState.moved && Math.abs(deltaY) > DRAG_THRESHOLD_PX) {
      // 小于阈值仍视为点击，超过阈值才屏蔽后续 click，避免拖动结束时误选中某个时间项。
      dragState.moved = true;
      suppressClickRef.current = true;
    }

    if (!dragState.moved) return;

    event.preventDefault();
    container.scrollTop = dragState.startScrollTop - deltaY;
    updateDisplayFromScroll();
  }, [updateDisplayFromScroll]);

  const finishPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    dragStateRef.current = null;
    setIsDragging(false);

    if (dragState.moved) {
      snapToNearest();
      setTimeout(() => {
        // 延后一轮事件循环再恢复 click，让浏览器合成 click 先被当前拖拽周期吞掉。
        suppressClickRef.current = false;
      }, 0);
      return;
    }

    suppressClickRef.current = false;
  }, [snapToNearest]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = getIndexForValue(valueRef.current);
    let nextIndex: number;

    switch (event.key) {
      case 'ArrowUp':
        nextIndex = currentIndex + 1;
        break;
      case 'ArrowDown':
        nextIndex = currentIndex - 1;
        break;
      case 'PageUp':
        nextIndex = currentIndex + 5;
        break;
      case 'PageDown':
        nextIndex = currentIndex - 5;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = options.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    commitValue(options[clamp(nextIndex, 0, options.length - 1)] ?? valueRef.current);
  }, [commitValue, getIndexForValue, options]);

  return (
    <div className="flex flex-col items-center">
      <span className="text-xs font-medium text-muted-foreground mb-2">{label}</span>
      <div className="relative">
        <div 
          className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-10 bg-primary/10 rounded-lg border border-primary/20 pointer-events-none z-0 shadow-[inset_0_0_18px_hsl(var(--primary)/0.08)]"
        />
        <div className="absolute inset-x-0 top-0 h-16 bg-linear-to-b from-card to-transparent pointer-events-none z-10" />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card to-transparent pointer-events-none z-10" />
        
        <div
          ref={containerRef}
          role="spinbutton"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-valuemin={options[0] ?? 0}
          aria-valuemax={options[options.length - 1] ?? 0}
          aria-valuenow={displayValue}
          aria-valuetext={formatTimePart(displayValue)}
          onScroll={handleScroll}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerDrag}
          onPointerCancel={finishPointerDrag}
          onKeyDown={handleKeyDown}
          className={cn(
            "relative w-16 overflow-x-hidden overflow-y-auto scrollbar-hide outline-none select-none",
            "cursor-grab rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            isDragging && "cursor-grabbing",
          )}
          style={{ 
            scrollSnapType: 'y mandatory',
            scrollPaddingTop: ITEM_HEIGHT * PADDING_ITEMS,
            scrollPaddingBottom: ITEM_HEIGHT * PADDING_ITEMS,
            overscrollBehaviorX: 'none',
            overscrollBehaviorY: 'contain',
            touchAction: 'pan-y',
            height: ITEM_HEIGHT * VISIBLE_ITEMS,
            paddingTop: ITEM_HEIGHT * PADDING_ITEMS,
            paddingBottom: ITEM_HEIGHT * PADDING_ITEMS,
          }}
        >
          {options.map((option) => {
            const isSelected = option === displayValue;
            return (
              <button
                key={option}
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }

                  commitValue(option);
                }}
                style={{ height: ITEM_HEIGHT, scrollSnapAlign: 'center', scrollSnapStop: 'always' }}
                className={cn(
                  "w-full flex items-center justify-center text-lg font-medium tabular-nums transition-all",
                  isSelected 
                    ? "text-primary scale-110" 
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {formatTimePart(option)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function TimePicker({
  id,
  value,
  onChange,
  className,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  density = 'default',
}: TimePickerProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [hours, setHours] = useState(() => {
    const [h] = value.split(':');
    return parseTimePart(h, 23);
  });
  const [minutes, setMinutes] = useState(() => {
    const [, m] = value.split(':');
    return parseTimePart(m, 59);
  });
  const displayTime = `${formatTimePart(hours)}:${formatTimePart(minutes)}`;

  useEffect(() => {
    const [h, m] = value.split(':');
    setHours(parseTimePart(h, 23));
    setMinutes(parseTimePart(m, 59));
  }, [value]);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  const handleTimeChange = useCallback((newHours: number, newMinutes: number) => {
    setHours(newHours);
    setMinutes(newMinutes);
    const formatted = `${formatTimePart(newHours)}:${formatTimePart(newMinutes)}`;
    onChange(formatted);
  }, [onChange]);

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(disabled ? false : open);
  }, [disabled]);

  const quickTimes = [
    { label: '08:00', desc: t("time.morning") },
    { label: '12:00', desc: t("time.noon") },
    { label: '18:00', desc: t("time.evening") },
    { label: '21:00', desc: t("time.night") },
  ];
  const isCompact = density === 'compact';
  const buttonAriaLabel = ariaLabel ? `${ariaLabel} ${displayTime}` : t("time.notificationAria", { time: displayTime });
  useAppRootScrollLock(isOpen);

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          aria-label={buttonAriaLabel}
          aria-describedby={ariaDescribedBy}
          className={cn(
            isCompact
              ? "h-9 w-full justify-start border-border bg-background px-3 py-2 text-left font-medium tabular-nums hover:bg-accent hover:text-accent-foreground group"
              : "h-auto py-3 px-4 justify-start text-left font-normal border-border bg-secondary hover:bg-secondary/80 group",
            className,
          )}
        >
          {isCompact ? (
            <div className="flex min-w-0 items-center gap-2">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium tabular-nums">{displayTime}</span>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 group-hover:bg-primary/20 transition-colors">
                <Clock className="h-5 w-5 text-primary" />
              </div>
              <span className="text-2xl font-bold tracking-wider tabular-nums">{displayTime}</span>
            </div>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className={cn(
          "w-auto p-0 border-border bg-card pointer-events-auto",
          isCompact ? "shadow-lg" : "shadow-xl",
        )}
        align="start"
        sideOffset={isCompact ? 6 : 8}
      >
        <div className="flex items-center justify-center gap-2 p-4 pb-2">
          <WheelColumn
            options={HOUR_OPTIONS}
            value={hours}
            onChange={(h) => handleTimeChange(h, minutes)}
            label={t("time.hour")}
            ariaLabel={t("time.hour")}
          />
          
          <div className="flex h-50 flex-col items-center justify-center px-1">
            <span className="text-3xl font-bold text-primary">:</span>
          </div>
          
          <WheelColumn
            options={MINUTE_OPTIONS}
            value={minutes}
            onChange={(m) => handleTimeChange(hours, m)}
            label={t("time.minute")}
            ariaLabel={t("time.minute")}
          />
        </div>

        {!isCompact ? (
          <div className="border-t border-border p-3">
            <div className="grid grid-cols-4 gap-2">
              {quickTimes.map(({ label, desc }) => (
                <button
                  key={label}
                  onClick={() => {
                    const [h, m] = label.split(':');
                    handleTimeChange(parseTimePart(h, 23), parseTimePart(m, 59));
                  }}
                  className={cn(
                    "flex flex-col items-center py-2 px-1 rounded-lg text-xs font-medium transition-all",
                    value === label
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary/50 hover:bg-secondary text-foreground",
                  )}
                >
                  <span className="font-bold">{label}</span>
                  <span className="text-[10px] opacity-70">{desc}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

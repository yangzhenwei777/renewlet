/**
 * 主题选择器 + 自定义主题色（Settings 页使用）。
 *
 * 设计目标：
 * - 支持预设主题（emerald/ocean/...）以及自定义主题色
 * - 作为“纯 UI 组件”，只负责展示与触发回调；具体的应用/落库逻辑由上层处理
 */

import { useEffect, useState } from 'react';
import { Check, Moon, Sun, Sparkles, Pipette } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import type { CustomThemeColor, ThemeMode, ThemeVariant } from '@/types/theme';
import { DEFAULT_CUSTOM_THEME_COLOR } from '@/types/theme';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages';

interface ThemeOption {
  id: Exclude<ThemeVariant, 'custom'>;
  nameKey: MessageKey;
  descriptionKey: MessageKey;
  preview: {
    primary: string;
    accent: string;
    bg: string;
  };
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'emerald',
    nameKey: 'theme.emerald.name',
    descriptionKey: 'theme.emerald.description',
    preview: {
      primary: 'hsl(160, 84%, 39%)',
      accent: 'hsl(160, 84%, 45%)',
      bg: 'hsl(220, 20%, 6%)',
    },
  },
  {
    id: 'ocean',
    nameKey: 'theme.ocean.name',
    descriptionKey: 'theme.ocean.description',
    preview: {
      primary: 'hsl(210, 90%, 50%)',
      accent: 'hsl(200, 85%, 55%)',
      bg: 'hsl(220, 25%, 6%)',
    },
  },
  {
    id: 'sunset',
    nameKey: 'theme.sunset.name',
    descriptionKey: 'theme.sunset.description',
    preview: {
      primary: 'hsl(25, 95%, 53%)',
      accent: 'hsl(35, 90%, 55%)',
      bg: 'hsl(220, 20%, 6%)',
    },
  },
  {
    id: 'lavender',
    nameKey: 'theme.lavender.name',
    descriptionKey: 'theme.lavender.description',
    preview: {
      primary: 'hsl(270, 70%, 60%)',
      accent: 'hsl(280, 65%, 65%)',
      bg: 'hsl(220, 20%, 6%)',
    },
  },
  {
    id: 'rose',
    nameKey: 'theme.rose.name',
    descriptionKey: 'theme.rose.description',
    preview: {
      primary: 'hsl(340, 75%, 55%)',
      accent: 'hsl(350, 70%, 60%)',
      bg: 'hsl(220, 20%, 6%)',
    },
  },
];

/** 将 HEX 颜色转换为 HSL（用于颜色滑块/输入框同步）。 */
function hexToHsl(hex: string): CustomThemeColor {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return DEFAULT_CUSTOM_THEME_COLOR;

  const r = parseInt(result[1] ?? "00", 16) / 255;
  const g = parseInt(result[2] ?? "00", 16) / 255;
  const b = parseInt(result[3] ?? "00", 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** 将 HSL 转换为 HEX（用于在输入框中展示）。 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function ColorPicker({ 
  color, 
  onChange 
}: { 
  color: CustomThemeColor; 
  onChange: (color: CustomThemeColor) => void;
}) {
  const { t } = useI18n();
  const [hexValue, setHexValue] = useState(hslToHex(color.h, color.s, color.l));

  useEffect(() => {
    setHexValue(hslToHex(color.h, color.s, color.l));
  }, [color]);

  const handleHexChange = (hex: string) => {
    setHexValue(hex);
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      // 运行时主题 token 只保存 HSL，HEX 只是输入控件的人类友好表示。
      onChange(hexToHsl(hex));
    }
  };

  return (
    <div className="grid gap-4 p-1">
      <div 
        className="w-full h-16 rounded-lg border border-border"
        style={{ backgroundColor: `hsl(${color.h}, ${color.s}%, ${color.l}%)` }}
      />

      <div className="grid gap-2">
        <Label className="text-xs">{t("theme.hexColor")}</Label>
        <div className="flex gap-2">
          <Input
            value={hexValue}
            onChange={(e) => handleHexChange(e.target.value)}
            placeholder="#10B981"
            className="font-mono text-sm h-9"
          />
          <input
            type="color"
            value={hexValue}
            onChange={(e) => handleHexChange(e.target.value)}
            className="w-9 h-9 rounded border border-border cursor-pointer"
          />
        </div>
      </div>

      <div className="grid gap-3">
        <div className="grid gap-2">
          <div className="flex justify-between">
            <Label className="text-xs">{t("theme.hue")}</Label>
            <span className="text-xs text-muted-foreground">{color.h}°</span>
          </div>
          <div 
            className="h-3 rounded-full"
            style={{
              background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)'
            }}
          />
          <Slider
            value={[color.h]}
            onValueChange={(value) => onChange({ ...color, h: value[0] ?? color.h })}
            max={360}
            step={1}
            className="mt-1"
          />
        </div>

        <div className="grid gap-2">
          <div className="flex justify-between">
            <Label className="text-xs">{t("theme.saturation")}</Label>
            <span className="text-xs text-muted-foreground">{color.s}%</span>
          </div>
          <div 
            className="h-3 rounded-full"
            style={{
              background: `linear-gradient(to right, hsl(${color.h}, 0%, ${color.l}%), hsl(${color.h}, 100%, ${color.l}%))`
            }}
          />
          <Slider
            value={[color.s]}
            onValueChange={(value) => onChange({ ...color, s: value[0] ?? color.s })}
            max={100}
            step={1}
            className="mt-1"
          />
        </div>

        <div className="grid gap-2">
          <div className="flex justify-between">
            <Label className="text-xs">{t("theme.lightness")}</Label>
            <span className="text-xs text-muted-foreground">{color.l}%</span>
          </div>
          <div 
            className="h-3 rounded-full"
            style={{
              background: `linear-gradient(to right, hsl(${color.h}, ${color.s}%, 10%), hsl(${color.h}, ${color.s}%, 50%), hsl(${color.h}, ${color.s}%, 90%))`
            }}
          />
          <Slider
            value={[color.l]}
            onValueChange={(value) => onChange({ ...color, l: value[0] ?? color.l })}
            min={20}
            max={70}
            step={1}
            className="mt-1"
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label className="text-xs">{t("theme.quickPick")}</Label>
        <div className="flex flex-wrap gap-2">
          {[
            { h: 0, s: 75, l: 50, nameKey: 'theme.color.red' },
            { h: 30, s: 90, l: 50, nameKey: 'theme.color.orange' },
            { h: 50, s: 90, l: 45, nameKey: 'theme.color.yellow' },
            { h: 120, s: 60, l: 40, nameKey: 'theme.color.green' },
            { h: 180, s: 70, l: 45, nameKey: 'theme.color.cyan' },
            { h: 220, s: 80, l: 55, nameKey: 'theme.color.blue' },
            { h: 280, s: 65, l: 55, nameKey: 'theme.color.purple' },
            { h: 320, s: 70, l: 50, nameKey: 'theme.color.pink' },
          ].map((preset) => (
            <button
              key={preset.nameKey}
              onClick={() => onChange({ h: preset.h, s: preset.s, l: preset.l })}
              className="w-7 h-7 rounded-full border-2 border-background shadow-sm hover:scale-110 transition-transform"
              style={{ backgroundColor: `hsl(${preset.h}, ${preset.s}%, ${preset.l}%)` }}
              title={t(preset.nameKey as MessageKey)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 主题选择器的受控参数；外观即时预览与保存由 Settings controller 处理。 */
export interface ThemeSelectorProps {
  /** 明暗模式（light/dark/system）。 */
  mode: ThemeMode;
  /** 主题风格（emerald/ocean/.../custom）。 */
  variant: ThemeVariant;
  /** 自定义主题色（仅 variant=custom 时使用）。 */
  customColor: CustomThemeColor;
  /** 切换明暗模式回调。 */
  onModeChange: (mode: ThemeMode) => void;
  /** 切换主题风格回调。 */
  onVariantChange: (variant: ThemeVariant) => void;
  /** 修改自定义主题色回调。 */
  onCustomColorChange: (color: CustomThemeColor) => void;
}

export function ThemeSelector({
  mode,
  variant,
  customColor,
  onModeChange,
  onVariantChange,
  onCustomColorChange,
}: ThemeSelectorProps) {
  const { t } = useI18n();

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <label className="text-sm font-medium text-foreground">{t("theme.mode")}</label>
        <div className="flex gap-3">
          <button
            onClick={() => onModeChange('light')}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-all",
              mode === 'light'
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-secondary hover:bg-secondary/80 text-muted-foreground"
            )}
          >
            <Sun className="h-4 w-4" />
            <span className="text-sm font-medium">{t("theme.light")}</span>
          </button>
          <button
            onClick={() => onModeChange('dark')}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-all",
              mode === 'dark'
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-secondary hover:bg-secondary/80 text-muted-foreground"
            )}
          >
            <Moon className="h-4 w-4" />
            <span className="text-sm font-medium">{t("theme.dark")}</span>
          </button>
          <button
            onClick={() => onModeChange('system')}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-all",
              mode === 'system'
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-secondary hover:bg-secondary/80 text-muted-foreground"
            )}
          >
            <Sparkles className="h-4 w-4" />
            <span className="text-sm font-medium">{t("theme.system")}</span>
          </button>
        </div>
      </div>

      <div className="grid gap-3">
        <label className="text-sm font-medium text-foreground">{t("theme.variant")}</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => onVariantChange(option.id)}
              className={cn(
                "group relative flex flex-col items-center p-4 rounded-xl border transition-all",
                variant === option.id
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-primary/50"
              )}
            >
              <div
                className="w-full h-16 rounded-lg mb-3 relative overflow-hidden"
                style={{ backgroundColor: option.preview.bg }}
              >
                <div
                  className="absolute bottom-2 left-2 right-2 h-4 rounded"
                  style={{ 
                    background: `linear-gradient(135deg, ${option.preview.primary}, ${option.preview.accent})` 
                  }}
                />
                <div
                  className="absolute top-2 left-2 w-3 h-3 rounded-full"
                  style={{ backgroundColor: option.preview.primary }}
                />
                <div
                  className="absolute top-2 right-2 w-6 h-2 rounded"
                  style={{ backgroundColor: option.preview.accent, opacity: 0.6 }}
                />
              </div>

              <span className="text-sm font-medium text-foreground">{t(option.nameKey)}</span>
              <span className="text-xs text-muted-foreground mt-0.5 text-center">
                {t(option.descriptionKey)}
              </span>

              {variant === option.id && (
                <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                  <Check className="h-3 w-3 text-primary-foreground" />
                </div>
              )}
            </button>
          ))}

          <Popover>
            <PopoverTrigger asChild>
              <button
                onClick={() => onVariantChange('custom')}
                className={cn(
                  "group relative flex flex-col items-center p-4 rounded-xl border transition-all",
                  variant === 'custom'
                    ? "border-primary ring-2 ring-primary/20"
                    : "border-border hover:border-primary/50"
                )}
              >
                <div
                  className="w-full h-16 rounded-lg mb-3 relative overflow-hidden"
                  style={{ backgroundColor: 'hsl(220, 20%, 6%)' }}
                >
                  <div
                    className="absolute bottom-2 left-2 right-2 h-4 rounded"
                    style={{ 
                      background: `linear-gradient(135deg, hsl(${customColor.h}, ${customColor.s}%, ${customColor.l}%), hsl(${customColor.h}, ${customColor.s}%, ${Math.min(customColor.l + 10, 100)}%))` 
                    }}
                  />
                  <div
                    className="absolute top-2 left-2 w-3 h-3 rounded-full"
                    style={{ backgroundColor: `hsl(${customColor.h}, ${customColor.s}%, ${customColor.l}%)` }}
                  />
                  <Pipette className="absolute top-2 right-2 w-4 h-4 text-white/60" />
                </div>

                <span className="text-sm font-medium text-foreground">{t("theme.custom")}</span>
                <span className="text-xs text-muted-foreground mt-0.5 text-center">
                  {t("theme.customDescription")}
                </span>

                {variant === 'custom' && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                    <Check className="h-3 w-3 text-primary-foreground" />
                  </div>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72" align="center">
              <ColorPicker color={customColor} onChange={onCustomColorChange} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

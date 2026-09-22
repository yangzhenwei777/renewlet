import { useEffect, useRef, useState } from "react";
import { FieldError } from "@/components/ui/field-error";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nProvider";
import type { ResolvedThemeMode } from "@/types/theme";

const TURNSTILE_SCRIPT_ID = "renewlet-turnstile-api";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileWidgetStatus = "loading" | "active" | "expired" | "failed";
export type TurnstileTheme = ResolvedThemeMode;

interface TurnstileRenderOptions {
  sitekey: string;
  theme: TurnstileTheme;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  "timeout-callback": () => void;
}

interface TurnstileAPI {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI;
  }
}

let turnstileScriptPromise: Promise<TurnstileAPI> | null = null;

export interface TurnstileWidgetProps {
  siteKey: string;
  theme: TurnstileTheme;
  errorId: string;
  error?: string | undefined;
  resetSignal: number;
  className?: string;
  onTokenChange: (token: string) => void;
}

export function TurnstileWidget({ siteKey, theme, errorId, error, resetSignal, className, onTokenChange }: TurnstileWidgetProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const lastResetSignalRef = useRef(resetSignal);
  const [status, setStatus] = useState<TurnstileWidgetStatus>("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !siteKey) return;
    let disposed = false;
    setStatus("loading");
    // siteKey/theme 变化会重建 Cloudflare iframe；旧 token 绑定旧 widget，必须先清空再等待新回调。
    onTokenChange("");

    void loadTurnstileScript()
      .then((turnstile) => {
        if (disposed || !containerRef.current) return;
        // Turnstile 在第三方 iframe 内渲染，无法继承 Renewlet CSS token；必须传应用解析后的 light/dark，不能用跟系统偏好的 auto。
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          callback: (token) => {
            setStatus("active");
            onTokenChange(token);
          },
          "expired-callback": () => {
            setStatus("expired");
            onTokenChange("");
          },
          "error-callback": () => {
            setStatus("failed");
            onTokenChange("");
          },
          "timeout-callback": () => {
            setStatus("expired");
            onTokenChange("");
          },
        });
        // Cloudflare callback 只代表挑战成功拿到 token，不代表 iframe 首次可见；loading 只能绑定 script/render 生命周期。
        setStatus("active");
      })
      .catch(() => {
        if (!disposed) {
          setStatus("failed");
          onTokenChange("");
        }
      });

    return () => {
      disposed = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Turnstile iframe 生命周期由 Cloudflare 脚本管理；remove 失败只影响清理，不应打断登录页卸载。
        }
      }
      if (container) container.replaceChildren();
    };
  }, [onTokenChange, siteKey, theme]);

  useEffect(() => {
    if (lastResetSignalRef.current === resetSignal) return;
    lastResetSignalRef.current = resetSignal;
    // resetSignal 只重置当前 widget：登录失败、挑战过期或上游错误后，旧 token 不能再次随表单提交。
    onTokenChange("");
    const widgetId = widgetIdRef.current;
    if (widgetId && window.turnstile) {
      try {
        window.turnstile.reset(widgetId);
        setStatus("active");
      } catch {
        setStatus("failed");
      }
    }
  }, [onTokenChange, resetSignal]);

  const statusMessage = status === "loading"
    ? t("auth.turnstileLoading")
    : status === "expired"
      ? t("auth.turnstileExpired")
      : status === "failed"
        ? t("auth.turnstileFailed")
        : "";

  return (
    <div className={cn("grid gap-2", className)} data-turnstile-theme={theme}>
      <div
        className={cn(
          "min-h-19 overflow-hidden rounded-md border border-border bg-secondary/30 p-2 transition-colors",
          error && "border-destructive/70",
        )}
      >
        <div ref={containerRef} />
      </div>
      {statusMessage ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {statusMessage}
        </p>
      ) : null}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function loadTurnstileScript(): Promise<TurnstileAPI> {
  if (typeof window === "undefined") return Promise.reject(new Error("Turnstile requires a browser"));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise<TurnstileAPI>((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const handleLoad = () => {
      if (window.turnstile) {
        script.dataset["renewletLoaded"] = "true";
        resolve(window.turnstile);
      } else {
        reject(new Error("Turnstile script loaded without API"));
      }
    };
    const handleError = () => reject(new Error("Turnstile script failed to load"));

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    if (!existing) {
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (script.dataset["renewletLoaded"] === "true") {
      // 登录页可能在客户端路由来回挂载；已有脚本若已加载完，不能再等一次不会发生的 load 事件。
      window.setTimeout(handleLoad, 0);
    }
  }).catch((error: unknown) => {
    turnstileScriptPromise = null;
    throw error;
  });

  return turnstileScriptPromise;
}

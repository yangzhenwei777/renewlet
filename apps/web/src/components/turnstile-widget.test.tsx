import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnstileWidget } from "./turnstile-widget";

type RenderOptions = {
  sitekey: string;
  theme: "light" | "dark";
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  "timeout-callback": () => void;
};

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

// 组件测试保护第三方 iframe 生命周期：theme/siteKey 变化必须丢弃旧 token，resetSignal 只能重置当前 widget。
function installTurnstile() {
  let widgetCounter = 0;
  const api = {
    render: vi.fn((_container: HTMLElement, _options: RenderOptions) => {
      widgetCounter += 1;
      return `widget-${widgetCounter}`;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;
  return api;
}

function getRenderOptions(api: ReturnType<typeof installTurnstile>, index = 0): RenderOptions {
  const options = api.render.mock.calls[index]?.[1];
  if (!options) throw new Error(`Missing Turnstile render options at index ${index}`);
  return options as RenderOptions;
}

describe("TurnstileWidget", () => {
  afterEach(() => {
    cleanup();
    delete window.turnstile;
    document.getElementById("renewlet-turnstile-api")?.remove();
  });

  it("passes the resolved Renewlet theme to Cloudflare render options", async () => {
    const api = installTurnstile();

    render(<TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={0} onTokenChange={vi.fn()} />);

    await waitFor(() => {
      expect(api.render).toHaveBeenCalledTimes(1);
    });
    expect(getRenderOptions(api)).toMatchObject({ sitekey: "site-key", theme: "dark" });
  });

  it("shows loading only while the Cloudflare script is not ready", () => {
    render(<TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={0} onTokenChange={vi.fn()} />);

    expect(screen.getByText("auth.turnstileLoading")).toBeInTheDocument();
  });

  it("stops showing loading after render even before a token callback", async () => {
    const api = installTurnstile();
    const onTokenChange = vi.fn();

    render(<TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={0} onTokenChange={onTokenChange} />);

    await waitFor(() => {
      expect(api.render).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("auth.turnstileLoading")).not.toBeInTheDocument();
    expect(onTokenChange).toHaveBeenCalledWith("");
    expect(onTokenChange).not.toHaveBeenCalledWith("turnstile-token");
  });

  it("emits the token when Cloudflare reports a successful challenge", async () => {
    const api = installTurnstile();
    const onTokenChange = vi.fn();

    render(<TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={0} onTokenChange={onTokenChange} />);

    await waitFor(() => {
      expect(api.render).toHaveBeenCalledTimes(1);
    });
    act(() => {
      getRenderOptions(api).callback("turnstile-token");
    });

    expect(onTokenChange).toHaveBeenCalledWith("turnstile-token");
  });

  it("clears the token and reports expired, failed and timeout states", async () => {
    const api = installTurnstile();
    const onTokenChange = vi.fn();

    render(<TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={0} onTokenChange={onTokenChange} />);

    await waitFor(() => {
      expect(api.render).toHaveBeenCalledTimes(1);
    });
    onTokenChange.mockClear();

    act(() => {
      getRenderOptions(api)["expired-callback"]();
    });
    expect(onTokenChange).toHaveBeenCalledWith("");
    expect(screen.getByText("auth.turnstileExpired")).toBeInTheDocument();

    act(() => {
      getRenderOptions(api)["error-callback"]();
    });
    expect(screen.getByText("auth.turnstileFailed")).toBeInTheDocument();

    act(() => {
      getRenderOptions(api)["timeout-callback"]();
    });
    expect(screen.getByText("auth.turnstileExpired")).toBeInTheDocument();
  });

  it("recreates the widget and clears the token when the theme changes", async () => {
    const api = installTurnstile();
    const onTokenChange = vi.fn();
    const { rerender } = render(
      <TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={0} onTokenChange={onTokenChange} />,
    );

    await waitFor(() => {
      expect(api.render).toHaveBeenCalledTimes(1);
    });
    act(() => {
      getRenderOptions(api).callback("dark-token");
    });
    onTokenChange.mockClear();

    rerender(<TurnstileWidget siteKey="site-key" theme="light" errorId="test-turnstile-error" resetSignal={0} onTokenChange={onTokenChange} />);

    await waitFor(() => {
      expect(api.render).toHaveBeenCalledTimes(2);
    });
    expect(api.remove).toHaveBeenCalledWith("widget-1");
    expect(onTokenChange).toHaveBeenCalledWith("");
    expect(getRenderOptions(api, 1)).toMatchObject({ sitekey: "site-key", theme: "light" });
  });

  it("resets the current widget without rerendering it when resetSignal changes", async () => {
    const api = installTurnstile();
    const onTokenChange = vi.fn();
    const { rerender } = render(
      <TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={0} onTokenChange={onTokenChange} />,
    );

    await waitFor(() => {
      expect(api.render).toHaveBeenCalledTimes(1);
    });
    api.remove.mockClear();
    onTokenChange.mockClear();

    rerender(<TurnstileWidget siteKey="site-key" theme="dark" errorId="test-turnstile-error" resetSignal={1} onTokenChange={onTokenChange} />);

    await waitFor(() => {
      expect(api.reset).toHaveBeenCalledWith("widget-1");
    });
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(api.remove).not.toHaveBeenCalled();
    expect(onTokenChange).toHaveBeenCalledWith("");
    expect(screen.queryByText("auth.turnstileLoading")).not.toBeInTheDocument();
  });
});

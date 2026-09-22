// AuthorizedImage 测试保护外链隐私边界和私有资产认证分支，避免图片组件退化成普通 img 包装。
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthorizedImage } from "./authorized-image";

describe("AuthorizedImage", () => {
  it("uses no-referrer for external http(s) images", () => {
    render(<AuthorizedImage src="https://example.com/logo.png" alt="Example" />);

    expect(screen.getByAltText("Example")).toHaveAttribute("src", "https://example.com/logo.png");
    expect(screen.getByAltText("Example")).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.getByAltText("Example")).toHaveAttribute("loading", "lazy");
    expect(screen.getByAltText("Example")).toHaveAttribute("decoding", "async");
  });

  it("allows callers to override loading and decoding when a hero image needs it", () => {
    render(<AuthorizedImage src="https://example.com/logo.png" alt="Hero" loading="eager" decoding="sync" />);

    expect(screen.getByAltText("Hero")).toHaveAttribute("loading", "eager");
    expect(screen.getByAltText("Hero")).toHaveAttribute("decoding", "sync");
  });
});

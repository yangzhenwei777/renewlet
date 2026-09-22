// public-routes 测试保护未登录可访问页面白名单，避免刷新法务/setup/reset 页面时被守卫误重定向。
import { describe, expect, it } from "vitest";
import { isPublicRoutePath } from "./public-routes";

describe("isPublicRoutePath", () => {
  it("allows login, setup, legal pages, and password reset pages", () => {
    expect(isPublicRoutePath("/login")).toBe(true);
    expect(isPublicRoutePath("/setup")).toBe(true);
    expect(isPublicRoutePath("/forgot-password")).toBe(true);
    expect(isPublicRoutePath("/reset-password")).toBe(true);
    expect(isPublicRoutePath("/terms")).toBe(true);
    expect(isPublicRoutePath("/privacy")).toBe(true);
  });

  it("allows public status pages", () => {
    expect(isPublicRoutePath("/status/abc123abc123abc123abc123abc123abc123abc123a")).toBe(true);
    expect(isPublicRoutePath("/status")).toBe(false);
  });

  it("keeps application pages protected", () => {
    expect(isPublicRoutePath("/settings")).toBe(false);
    expect(isPublicRoutePath("/admin/users")).toBe(false);
  });
});

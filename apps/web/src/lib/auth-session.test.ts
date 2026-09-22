import { beforeEach, describe, expect, it } from "vitest";
import { readProductSession, readProductSessionSnapshot, writeProductSession } from "@/services/product-session";
import { ACCOUNT_LOCALE_PROJECTION_KEY, writeAccountLocaleProjection } from "@/i18n/account-locale-projection";
import { clearAuthSession } from "./auth-session";

const sessionFixture = {
  type: "session" as const,
  session: { expiresAt: "2026-07-03T00:00:00.000Z" },
  user: {
    id: "user-1",
    email: "alice@example.com",
    name: "Alice",
    role: "admin",
    banned: false,
  },
};

describe("auth-session helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("does not clear a newer product session when an older validation fails", () => {
    // 旧请求的 401 不能清掉用户刚刷新的 session，这是登录竞态的核心防线。
    writeProductSession(sessionFixture);
    const oldSnapshot = readProductSessionSnapshot();
    writeProductSession({
      ...sessionFixture,
      session: { expiresAt: "2026-08-03T00:00:00.000Z" },
    });

    clearAuthSession(oldSnapshot);

    expect(readProductSession()?.session.expiresAt).toBe("2026-08-03T00:00:00.000Z");
  });

  it("clears the current product session when the failing snapshot matches", () => {
    writeProductSession(sessionFixture);
    writeAccountLocaleProjection("user-1", "en-US");
    const snapshot = readProductSessionSnapshot();

    clearAuthSession(snapshot);

    expect(readProductSession()).toBeNull();
    expect(localStorage.getItem(ACCOUNT_LOCALE_PROJECTION_KEY)).toBeNull();
  });

  it("clears the previous account locale projection when the signed-in user changes", () => {
    writeProductSession(sessionFixture);
    writeAccountLocaleProjection("user-1", "en-US");

    writeProductSession({
      ...sessionFixture,
      user: { ...sessionFixture.user, id: "user-2", email: "bob@example.com" },
    });

    expect(readProductSession()?.user.id).toBe("user-2");
    expect(localStorage.getItem(ACCOUNT_LOCALE_PROJECTION_KEY)).toBeNull();
  });

});

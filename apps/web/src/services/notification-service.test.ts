import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { notificationService } from "./notification-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

describe("notificationService", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({});
  });

  it("keeps notification test timeout longer than the Worker provider timeout", async () => {
    await notificationService.test("discord", DEFAULT_SETTINGS);

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/notifications/test");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({
      method: "POST",
      timeoutMs: 20_000,
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { NOTIFICATION_CHANNELS } from "@renewlet/shared/runtime";
import { notificationSenders } from "./notification-channel-send";

vi.mock("./smtp", () => ({
  notificationSmtpConfig: vi.fn(),
  sendSmtpEmail: vi.fn(),
}));

describe("notification sender registry", () => {
  it("registers every shared notification channel exactly once", () => {
    expect(Object.keys(notificationSenders).sort()).toEqual([...NOTIFICATION_CHANNELS].sort());
  });
});

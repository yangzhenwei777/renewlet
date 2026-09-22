import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function clearClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

function stubExecCommand(result: boolean) {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

function restoreDescriptor<T extends object>(target: T, key: keyof T, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

describe("copyTextToClipboard", () => {
  afterEach(() => {
    restoreDescriptor(navigator, "clipboard", originalClipboardDescriptor);
    restoreDescriptor(document, "execCommand", originalExecCommandDescriptor);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("uses Async Clipboard when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = stubExecCommand(true);
    stubClipboard(writeText);

    await expect(copyTextToClipboard("https://example.com/calendar")).resolves.toEqual({
      ok: true,
      method: "async-clipboard",
    });
    expect(writeText).toHaveBeenCalledWith("https://example.com/calendar");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to selected text when navigator.clipboard is missing", async () => {
    const execCommand = stubExecCommand(true);
    const input = document.createElement("input");
    input.value = "https://example.com/calendar";
    document.body.append(input);
    clearClipboard();

    await expect(copyTextToClipboard("https://example.com/calendar", { target: input })).resolves.toEqual({
      ok: true,
      method: "selection-fallback",
    });
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back when Async Clipboard rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const execCommand = stubExecCommand(true);
    const input = document.createElement("input");
    input.value = "https://example.com/status/secret";
    document.body.append(input);
    stubClipboard(writeText);

    await expect(copyTextToClipboard("https://example.com/status/secret", { target: input })).resolves.toEqual({
      ok: true,
      method: "selection-fallback",
    });
    expect(writeText).toHaveBeenCalledWith("https://example.com/status/secret");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("keeps the visible target selected when every copy path fails", async () => {
    const execCommand = stubExecCommand(false);
    const input = document.createElement("input");
    input.value = "https://example.com/calendar";
    document.body.append(input);
    clearClipboard();

    const result = await copyTextToClipboard("https://example.com/calendar", { target: input });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unavailable");
    }
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});

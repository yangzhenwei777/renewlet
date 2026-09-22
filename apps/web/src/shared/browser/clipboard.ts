export type ClipboardCopyTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export type ClipboardCopyMethod = "async-clipboard" | "selection-fallback";
export type ClipboardCopyFailureReason = "empty" | "unavailable" | "blocked";

export type ClipboardCopyResult =
  | { ok: true; method: ClipboardCopyMethod }
  | { ok: false; reason: ClipboardCopyFailureReason; error: unknown };

interface CopyTextOptions {
  target?: ClipboardCopyTarget | null | undefined;
}

interface SelectionSnapshot {
  activeElement: HTMLElement | null;
  ranges: Range[];
}

interface SelectionCopyResult {
  ok: boolean;
  error: unknown;
}

export async function copyTextToClipboard(text: string, options: CopyTextOptions = {}): Promise<ClipboardCopyResult> {
  if (!text) return { ok: false, reason: "empty", error: new Error("Cannot copy empty text") };

  let asyncClipboardError: unknown = null;
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const writeText = clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(clipboard, text);
      return { ok: true, method: "async-clipboard" };
    } catch (error) {
      asyncClipboardError = error;
    }
  }

  const fallback = copyBySelection(text, options.target ?? null);
  if (fallback.ok) return { ok: true, method: "selection-fallback" };

  return {
    ok: false,
    reason: asyncClipboardError ? "blocked" : "unavailable",
    error: fallback.error ?? asyncClipboardError ?? new Error("Clipboard copy is unavailable"),
  };
}

function copyBySelection(text: string, target: ClipboardCopyTarget | null): SelectionCopyResult {
  if (typeof document === "undefined" || typeof document.execCommand !== "function" || !document.body) {
    return { ok: false, error: new Error("Selection copy is unavailable") };
  }

  const snapshot = createSelectionSnapshot();
  const temporaryTarget = target ? null : createTemporaryTextarea(text);
  const copyTarget = target ?? temporaryTarget;
  let copied = false;

  try {
    if (!copyTarget) return { ok: false, error: new Error("Selection target is unavailable") };
    selectCopyTarget(copyTarget);
    copied = document.execCommand("copy");
    return { ok: copied, error: copied ? null : new Error("Selection copy was rejected") };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (temporaryTarget) temporaryTarget.remove();
    // 成功复制后恢复点击前焦点；失败时保留可见目标选区，方便用户直接手动复制。
    if (copied) restoreSelectionSnapshot(snapshot);
  }
}

function createTemporaryTextarea(text: string): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  return textarea;
}

function selectCopyTarget(target: ClipboardCopyTarget): void {
  if (isTextControl(target)) {
    target.focus({ preventScroll: true });
    target.select();
    return;
  }

  target.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
}

function createSelectionSnapshot(): SelectionSnapshot {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
  }
  return {
    activeElement: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    ranges,
  };
}

function restoreSelectionSnapshot(snapshot: SelectionSnapshot): void {
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    for (const range of snapshot.ranges) {
      selection.addRange(range);
    }
  }
  snapshot.activeElement?.focus({ preventScroll: true });
}

function isTextControl(target: ClipboardCopyTarget): target is HTMLInputElement | HTMLTextAreaElement {
  return (
    (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement)
    || (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement)
  );
}

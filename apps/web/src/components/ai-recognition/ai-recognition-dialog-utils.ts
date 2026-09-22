import type { RefObject } from "react";
import type { AiThinkingControl } from "@/lib/api/schemas/ai-recognition";
import { thinkingOptionId } from "@/modules/ai-recognition/domain/model-capabilities";
import type { AIRecognitionImageItem } from "./ai-recognition-dialog-types";

// thinking 控件的选项 id 由领域层生成，避免 UI 组件把 provider/model 差异硬编码到表单状态里。
export function thinkingOptionIdOrNull(control: AiThinkingControl | null): string | null {
  return control ? thinkingOptionId(control) : null;
}

export function nextImageId(ref: RefObject<number>): string {
  ref.current += 1;
  return `ai-image-${ref.current}`;
}

export function nextDraftId(ref: RefObject<number>): string {
  ref.current += 1;
  return `ai-draft-${ref.current}`;
}

export function createObjectUrl(file: File): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(file);
}

export function revokeImageItem(image: AIRecognitionImageItem) {
  if (image.thumbnailUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(image.thumbnailUrl);
  }
}

export function revokeImageItems(images: readonly AIRecognitionImageItem[]) {
  for (const image of images) revokeImageItem(image);
}

export function appendLimitedText(current: string, delta: string, maxChars: number): string {
  const next = `${current}${delta}`;
  const chars = [...next];
  // SSE 文本预览保留尾部窗口即可排障，不能把 provider 的完整输出长期堆在 React 状态里。
  if (chars.length <= maxChars) return next;
  return `...${chars.slice(chars.length - maxChars).join("")}`;
}

export function recognitionElapsedSeconds(startedAt: number): number {
  return Math.max(1, Math.ceil((performance.now() - startedAt) / 1000));
}

export function isAbortedApiError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "aborted",
  );
}

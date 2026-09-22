import type { WorkerJobProgress } from "@/lib/workers/job-protocol";

export type AIRecognitionImagePreprocessWarning = "large-after-optimization";
export type AIRecognitionImagePreprocessErrorCode = "too-large" | "unsupported";

export interface AIImagePreprocessWorkerPayload {
  buffer: ArrayBuffer;
  mimeType: string;
  targetBytes: number;
  maxBytes: number;
  maxEdge: number;
}

export interface AIImagePreprocessWorkerResult {
  buffer: ArrayBuffer;
  mimeType: string;
  optimized: boolean;
  warning: AIRecognitionImagePreprocessWarning | null;
}

export type AIImagePreprocessProgress = WorkerJobProgress;

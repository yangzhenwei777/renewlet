import type { WorkerJobEvent, WorkerJobRequest } from "@/lib/workers/job-protocol";
import type {
  RenewletExportWorkerPayload,
  RenewletExportWorkerResult,
} from "./renewlet-export-worker-contract";

const cancelledJobs = new Set<string>();

self.onmessage = (event: MessageEvent<WorkerJobRequest<RenewletExportWorkerPayload>>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledJobs.add(message.jobId);
    return;
  }
  void generateArchive(message.jobId, message.payload);
};

async function generateArchive(jobId: string, payload: RenewletExportWorkerPayload): Promise<void> {
  try {
    const { default: JSZip } = await import("jszip");
    assertActive(jobId);
    const zip = new JSZip();
    for (const entry of payload.entries) zip.file(entry.name, entry.data);
    const buffer = await zip.generateAsync(
      { type: "arraybuffer", compression: "DEFLATE" },
      ({ percent }) => {
        if (cancelledJobs.has(jobId)) return;
        postMessage({
          type: "progress",
          jobId,
          progress: { completed: Math.round(percent), total: 100, phase: "compress" },
        } satisfies WorkerJobEvent<never>);
      },
    );
    assertActive(jobId);
    postMessage(
      { type: "result", jobId, result: { buffer } } satisfies WorkerJobEvent<RenewletExportWorkerResult>,
      { transfer: [buffer] },
    );
  } catch (error) {
    if (cancelledJobs.has(jobId)) return;
    postMessage({
      type: "error",
      jobId,
      error: error instanceof Error ? error.message : "EXPORT_WORKER_FAILED",
    } satisfies WorkerJobEvent<never>);
  } finally {
    cancelledJobs.delete(jobId);
  }
}

function assertActive(jobId: string): void {
  if (cancelledJobs.has(jobId)) throw new DOMException("Worker job cancelled", "AbortError");
}

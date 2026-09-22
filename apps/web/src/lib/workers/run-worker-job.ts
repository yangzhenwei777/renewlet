import type {
  WorkerJobEvent,
  WorkerJobProgress,
  WorkerJobRequest,
} from "./job-protocol";

let nextWorkerJobId = 0;

export interface RunWorkerJobOptions<TPayload> {
  createWorker: () => Worker;
  payload: TPayload;
  transfer?: Transferable[];
  signal?: AbortSignal;
  onProgress?: (progress: WorkerJobProgress) => void;
}

/**
 * 每个调用独占一个 Dedicated Worker；完成、失败或取消都会终止实例。
 * transfer 列表中的 ArrayBuffer 发出后归 Worker 所有，调用方不得再读取原 buffer。
 */
export function runWorkerJob<TPayload, TResult>({
  createWorker,
  payload,
  transfer = [],
  signal,
  onProgress,
}: RunWorkerJobOptions<TPayload>): Promise<TResult> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  const jobId = `worker-job-${nextWorkerJobId += 1}`;
  let worker: Worker;
  try {
    worker = createWorker();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      callback();
    };
    const handleAbort = () => {
      try {
        worker.postMessage({ type: "cancel", jobId } satisfies WorkerJobRequest<never>);
      } catch {
        // Dedicated Worker 随后会被强制终止；取消消息发送失败不能把统一 AbortError 替换成 clone/生命周期异常。
      } finally {
        settle(() => reject(createAbortError()));
      }
    };

    worker.onmessage = (event: MessageEvent<WorkerJobEvent<TResult>>) => {
      const message = event.data;
      if (message.jobId !== jobId) return;
      if (message.type === "progress") {
        onProgress?.(message.progress);
        return;
      }
      if (message.type === "result") {
        settle(() => resolve(message.result));
        return;
      }
      settle(() => reject(new Error(message.error)));
    };
    worker.onerror = () => settle(() => reject(new Error("WORKER_JOB_FAILED")));
    worker.onmessageerror = () => settle(() => reject(new Error("WORKER_MESSAGE_INVALID")));
    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      worker.postMessage(
        { type: "start", jobId, payload } satisfies WorkerJobRequest<TPayload>,
        { transfer },
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function createAbortError(): Error {
  return new DOMException("Worker job cancelled", "AbortError");
}

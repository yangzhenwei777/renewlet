import { describe, expect, it, vi } from "vitest";
import { runWorkerJob } from "./run-worker-job";

class WorkerFixture {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  emit(data: unknown) {
    this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data }));
  }
}

describe("runWorkerJob", () => {
  it("owns one worker through progress and transfers the result", async () => {
    const worker = new WorkerFixture();
    const onProgress = vi.fn();
    const input = new ArrayBuffer(8);
    const result = runWorkerJob<{ input: ArrayBuffer }, { output: string }>({
      createWorker: () => worker as unknown as Worker,
      payload: { input },
      transfer: [input],
      onProgress,
    });
    const start = worker.postMessage.mock.calls[0]?.[0] as { jobId: string };

    worker.emit({ type: "progress", jobId: start.jobId, progress: { completed: 1, total: 2 } });
    worker.emit({ type: "result", jobId: start.jobId, result: { output: "done" } });

    await expect(result).resolves.toEqual({ output: "done" });
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: "start", jobId: start.jobId, payload: { input } },
      { transfer: [input] },
    );
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 2 });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("sends the matching cancel job and always terminates on abort", async () => {
    const worker = new WorkerFixture();
    const controller = new AbortController();
    const result = runWorkerJob({
      createWorker: () => worker as unknown as Worker,
      payload: { value: 1 },
      signal: controller.signal,
    });
    const start = worker.postMessage.mock.calls[0]?.[0] as { jobId: string };

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.postMessage).toHaveBeenNthCalledWith(2, { type: "cancel", jobId: start.jobId });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps AbortError semantics when posting the cancel message fails", async () => {
    const worker = new WorkerFixture();
    const controller = new AbortController();
    const result = runWorkerJob({
      createWorker: () => worker as unknown as Worker,
      payload: { value: 1 },
      signal: controller.signal,
    });
    worker.postMessage.mockImplementationOnce(() => {
      throw new DOMException("worker already stopped", "InvalidStateError");
    });

    expect(() => controller.abort()).not.toThrow();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates when transferring the start message fails", async () => {
    const worker = new WorkerFixture();
    worker.postMessage.mockImplementation(() => {
      throw new DOMException("detached", "DataCloneError");
    });

    await expect(runWorkerJob({
      createWorker: () => worker as unknown as Worker,
      payload: { value: 1 },
    })).rejects.toMatchObject({ name: "DataCloneError" });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

export interface WorkerJobProgress {
  completed: number;
  total: number;
  phase?: string;
}

export type WorkerJobRequest<TPayload> =
  | { type: "start"; jobId: string; payload: TPayload }
  | { type: "cancel"; jobId: string };

export type WorkerJobEvent<TResult> =
  | { type: "progress"; jobId: string; progress: WorkerJobProgress }
  | { type: "result"; jobId: string; result: TResult }
  | { type: "error"; jobId: string; error: string };

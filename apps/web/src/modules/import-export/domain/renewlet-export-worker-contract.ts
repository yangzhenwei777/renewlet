export interface RenewletExportWorkerEntry {
  name: string;
  data: string | ArrayBuffer;
}

export interface RenewletExportWorkerPayload {
  entries: RenewletExportWorkerEntry[];
}

export interface RenewletExportWorkerResult {
  buffer: ArrayBuffer;
}

import type { PreparedImport } from "./import-export-model";
import type { ImportBuildBaseContext } from "./wallos-import-mapping";

export interface WallosImportWorkerPayload {
  buffer: ArrayBuffer;
  context: ImportBuildBaseContext;
  maxFileBytes: number;
  wallosUserId?: string;
}

export type WallosImportWorkerResult = PreparedImport;

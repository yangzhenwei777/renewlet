import { MAX_IMPORT_PREVIEW_SUBSCRIPTIONS } from "./import-export-model";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const CENTRAL_DIRECTORY_ENTRY_BYTES = 46;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const ZIP64_UINT16_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffffffff;

export const MAX_IMPORT_ZIP_ENTRIES = MAX_IMPORT_PREVIEW_SUBSCRIPTIONS * 3 + 8;

export class ZipFormatError extends Error {}
export class ZipLimitExceededError extends Error {}

export interface ZipCentralDirectoryEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
}

export interface ZipCentralDirectory {
  entries: readonly ZipCentralDirectoryEntry[];
  byName: ReadonlyMap<string, ZipCentralDirectoryEntry>;
}

/**
 * 只扫描 ZIP central directory，不解压 entry。导入入口先用声明的 uncompressed size 拒绝高压缩比文件，
 * 再交给 JSZip；这样容量门不依赖 JSZip 私有字段，也不会为了判断大小先分配解压结果。
 */
export function inspectZipCentralDirectory(bytes: Uint8Array, maxEntries: number): ZipCentralDirectory {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new ZipLimitExceededError("ZIP entry limit is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const diskNumber = readUint16(view, endOffset + 4);
  const centralDirectoryDisk = readUint16(view, endOffset + 6);
  const entriesOnDisk = readUint16(view, endOffset + 8);
  const entryCount = readUint16(view, endOffset + 10);
  const centralDirectorySize = readUint32(view, endOffset + 12);
  const centralDirectoryOffset = readUint32(view, endOffset + 16);
  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === ZIP64_UINT16_SENTINEL
    || centralDirectorySize === ZIP64_UINT32_SENTINEL
    || centralDirectoryOffset === ZIP64_UINT32_SENTINEL
  ) {
    throw new ZipFormatError("Multi-disk and ZIP64 imports are not supported");
  }
  if (entryCount > maxEntries) throw new ZipLimitExceededError("ZIP contains too many entries");

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (!Number.isSafeInteger(centralDirectoryEnd) || centralDirectoryEnd > endOffset) {
    throw new ZipFormatError("ZIP central directory is out of bounds");
  }

  const decoder = new TextDecoder("utf-8");
  const entries: ZipCentralDirectoryEntry[] = [];
  const byName = new Map<string, ZipCentralDirectoryEntry>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(view, offset, CENTRAL_DIRECTORY_ENTRY_BYTES);
    if (readUint32(view, offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new ZipFormatError("ZIP central directory entry signature is invalid");
    }
    const flags = readUint16(view, offset + 8);
    if ((flags & 0x1) !== 0) throw new ZipFormatError("Encrypted ZIP entries are not supported");
    const compressionMethod = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const uncompressedSize = readUint32(view, offset + 24);
    if (compressedSize === ZIP64_UINT32_SENTINEL || uncompressedSize === ZIP64_UINT32_SENTINEL) {
      throw new ZipFormatError("ZIP64 entries are not supported");
    }
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const entryBytes = CENTRAL_DIRECTORY_ENTRY_BYTES + nameLength + extraLength + commentLength;
    requireRange(view, offset, entryBytes);
    if (offset + entryBytes > centralDirectoryEnd) throw new ZipFormatError("ZIP central directory entry exceeds its boundary");
    const nameStart = offset + CENTRAL_DIRECTORY_ENTRY_BYTES;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (!name || byName.has(name)) throw new ZipFormatError("ZIP entry names must be non-empty and unique");
    const entry = { name, compressedSize, uncompressedSize, compressionMethod };
    entries.push(entry);
    byName.set(name, entry);
    offset += entryBytes;
  }
  if (offset !== centralDirectoryEnd) throw new ZipFormatError("ZIP central directory size does not match its entries");
  return { entries, byName };
}

export function assertZipEntryWithinLimit(entry: ZipCentralDirectoryEntry, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || entry.uncompressedSize > maxBytes) {
    throw new ZipLimitExceededError(`ZIP entry ${entry.name} exceeds the uncompressed size limit`);
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const firstCandidate = view.byteLength - END_OF_CENTRAL_DIRECTORY_BYTES;
  const earliestCandidate = Math.max(0, firstCandidate - MAX_ZIP_COMMENT_BYTES);
  for (let offset = firstCandidate; offset >= earliestCandidate; offset -= 1) {
    if (readUint32(view, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = readUint16(view, offset + 20);
    if (offset + END_OF_CENTRAL_DIRECTORY_BYTES + commentLength === view.byteLength) return offset;
  }
  throw new ZipFormatError("ZIP end of central directory is missing");
}

function readUint16(view: DataView, offset: number): number {
  requireRange(view, offset, 2);
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  requireRange(view, offset, 4);
  return view.getUint32(offset, true);
}

function requireRange(view: DataView, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new ZipFormatError("ZIP structure is truncated");
  }
}

type StoredZipSourceBase = {
  name: string;
  size: number;
  date?: Date;
};

export type StoredZipSource = StoredZipSourceBase & (
  | { load: () => Promise<Uint8Array>; text?: never }
  | { text: string; load?: never }
);

type PreparedStoredZipSource = StoredZipSource & {
  nameBytes: Uint8Array;
  localOffset: number;
};

const CRC32_TABLE = createCrc32Table();
const textEncoder = new TextEncoder();
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_END_BYTES = 22;

/**
 * store-only ZIP 先按 metadata 算出精确长度，再把每个 source 原位写进唯一输出 buffer。
 * load 必须一次只返回一个 entry；调用方不能把全部资产内容预先聚合到数组中。
 * 这里故意不压缩：可精确预判 16 MiB 峰值，也避免 Worker isolate 为压缩器再保留整份输入状态。
 */
export async function createStoredZipFromSources(
  sources: StoredZipSource[],
  date = new Date(),
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const prepared = prepareSources(sources);
  const totalBytes = storedZipSize(prepared);
  if (totalBytes > maxBytes) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
  const output = new Uint8Array(totalBytes);
  let localOffset = 0;
  const centralOffset = prepared.reduce((sum, source) => sum + ZIP_LOCAL_HEADER_BYTES + source.nameBytes.length + source.size, 0);
  let centralWriteOffset = centralOffset;

  for (const source of prepared) {
    const dataOffset = localOffset + ZIP_LOCAL_HEADER_BYTES + source.nameBytes.length;
    const outputData = output.subarray(dataOffset, dataOffset + source.size);
    if ("text" in source) {
      // JSON 直接编码进最终 ZIP，避免 16 MiB 快照再保留一份同尺寸 TextEncoder 中间副本。
      const encoded = textEncoder.encodeInto(source.text, outputData);
      if (encoded.read !== source.text.length || encoded.written !== source.size) {
        throw new Error("CLOUD_BACKUP_ASSET_SIZE_MISMATCH");
      }
    } else {
      const data = await source.load();
      if (data.length !== source.size) throw new Error("CLOUD_BACKUP_ASSET_SIZE_MISMATCH");
      outputData.set(data);
      // 循环体不保存 data 引用，下一项加载前允许当前 R2 ArrayBuffer 被回收，峰值保持“最终 ZIP + 单资产”。
    }
    const entryDate = source.date ?? date;
    const checksum = crc32(outputData);
    writeLocalHeader(output, localOffset, source.nameBytes, source.size, checksum, entryDate);
    localOffset = dataOffset + source.size;
    writeCentralHeader(output, centralWriteOffset, source.nameBytes, source.size, checksum, entryDate, source.localOffset);
    centralWriteOffset += ZIP_CENTRAL_HEADER_BYTES + source.nameBytes.length;
  }

  writeEndRecord(output, centralWriteOffset, prepared.length, centralWriteOffset - centralOffset, centralOffset);
  return output;
}

function prepareSources(sources: StoredZipSource[]): PreparedStoredZipSource[] {
  let localOffset = 0;
  return sources.map((source) => {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error("CLOUD_BACKUP_ASSET_SIZE_INVALID");
    const nameBytes = textEncoder.encode(sanitizeZipEntryName(source.name));
    const prepared = { ...source, nameBytes, localOffset };
    localOffset += ZIP_LOCAL_HEADER_BYTES + nameBytes.length + source.size;
    return prepared;
  });
}

function storedZipSize(sources: PreparedStoredZipSource[]): number {
  return sources.reduce((sum, source) => (
    sum + ZIP_LOCAL_HEADER_BYTES + ZIP_CENTRAL_HEADER_BYTES + source.nameBytes.length * 2 + source.size
  ), ZIP_END_BYTES);
}

function writeLocalHeader(output: Uint8Array, offset: number, name: Uint8Array, size: number, checksum: number, date: Date): void {
  const view = new DataView(output.buffer, output.byteOffset + offset, ZIP_LOCAL_HEADER_BYTES + name.length);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, toDosTime(date), true);
  view.setUint16(12, toDosDate(date), true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true);
  output.set(name, offset + ZIP_LOCAL_HEADER_BYTES);
}

function writeCentralHeader(
  output: Uint8Array,
  offset: number,
  name: Uint8Array,
  size: number,
  checksum: number,
  date: Date,
  localOffset: number,
): void {
  const view = new DataView(output.buffer, output.byteOffset + offset, ZIP_CENTRAL_HEADER_BYTES + name.length);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, toDosTime(date), true);
  view.setUint16(14, toDosDate(date), true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  output.set(name, offset + ZIP_CENTRAL_HEADER_BYTES);
}

function writeEndRecord(output: Uint8Array, offset: number, entries: number, centralSize: number, centralOffset: number): void {
  const view = new DataView(output.buffer, output.byteOffset + offset, ZIP_END_BYTES);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
}

function sanitizeZipEntryName(name: string): string {
  return name.split("/").map((part) => part.trim()).filter((part) => part && part !== "." && part !== "..").join("/") || "file.bin";
}

function toDosTime(date: Date): number {
  return (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
}

function toDosDate(date: Date): number {
  const year = Math.max(1980, date.getUTCFullYear());
  return ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

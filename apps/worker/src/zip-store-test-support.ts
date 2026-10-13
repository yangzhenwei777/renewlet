export function readStoredZipText(content: Uint8Array, name: string): string {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= content.length) {
    const view = new DataView(content.buffer, content.byteOffset + offset, content.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const entryName = decoder.decode(content.slice(nameStart, nameStart + nameLength));
    const data = content.slice(dataStart, dataStart + compressedSize);
    if (entryName === name) return decoder.decode(data);
    offset = dataStart + compressedSize;
  }
  throw new Error(`missing ZIP entry ${name}`);
}

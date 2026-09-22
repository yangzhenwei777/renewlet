/**
 * 将 Blob 以一次性 object URL 触发浏览器下载。
 *
 * 下载入口会被导出/日历等功能复用；点击完成后立即 revoke，避免大文件 Blob
 * 在长时间打开的自托管管理页里持续占用内存。
 */
export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// upload-image 测试保护 dataURL/multipart 上传契约，避免裁剪链路把非法 MIME 或超大图片送到服务端。
import { describe, expect, it } from "vitest";
import { dataUrlToBlob, validateImageFileForUpload } from "./upload-image";

describe("upload-image", () => {
  it("converts supported image data URLs into blobs", async () => {
    const blob = dataUrlToBlob(`data:image/png;base64,${btoa("hello")}`);

    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("hello");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`;
    const svgBlob = dataUrlToBlob(`data:image/svg+xml;base64,${btoa(svg)}`);

    expect(svgBlob.type).toBe("image/svg+xml");
    expect(await svgBlob.text()).toBe(svg);
  });

  it("rejects unsupported mime types and invalid base64", () => {
    expect(() => dataUrlToBlob(`data:image/gif;base64,${btoa("x")}`)).toThrow("仅支持");
    expect(() => dataUrlToBlob("data:image/png;base64,%%%")).toThrow("Invalid base64");
  });

  it("pre-validates upload files before FileReader work", () => {
    expect(validateImageFileForUpload(new File(["x"], "x.png", { type: "image/png" }))).toBeNull();
    expect(validateImageFileForUpload(new File(["<svg />"], "x.svg", { type: "image/svg+xml" }))).toBeNull();
    expect(validateImageFileForUpload(new File(["<svg />"], "x.svg", { type: "" }))).toBeNull();
    expect(validateImageFileForUpload(new File(["\0\0\x01\0"], "x.ico", { type: "image/x-icon" }))).toBeNull();
    expect(validateImageFileForUpload(new File(["\0\0\x01\0"], "x.ico", { type: "" }))).toBeNull();
    expect(validateImageFileForUpload(new File(["x"], "x.gif", { type: "image/gif" }))).toContain("仅支持");
  });
});

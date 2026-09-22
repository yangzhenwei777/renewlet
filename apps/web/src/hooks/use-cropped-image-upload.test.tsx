// 裁剪上传 hook 测试保护异步 token 状态机，防止旧 FileReader/上传结果覆盖用户后续选择。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadKind } from "@/lib/api/schemas/media";
import { uploadedAssetsQueryKeys } from "@/hooks/use-uploaded-assets";
import { useCroppedImageUpload } from "./use-cropped-image-upload";

const mocks = vi.hoisted(() => ({
  onChange: vi.fn(),
  uploadImageDataUrl: vi.fn(),
  uploadImageFile: vi.fn(),
  validateImageFileForUpload: vi.fn(),
}));

vi.mock("@/lib/upload-image", () => ({
  uploadImageDataUrl: mocks.uploadImageDataUrl,
  uploadImageFile: mocks.uploadImageFile,
  validateImageFileForUpload: mocks.validateImageFileForUpload,
}));

function UploadHarness({ kind = "logo" }: { kind?: UploadKind }) {
  const upload = useCroppedImageUpload({
    kind,
    filename: kind === "logo" ? "logo.png" : "icon.png",
    onChange: mocks.onChange,
  });

  return (
    <>
      <input data-testid="file" type="file" onChange={upload.handleFileUpload} />
      {upload.cropDialogOpen && <span>crop-open</span>}
      <span data-testid="status">{upload.uploadStatus}</span>
    </>
  );
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { Wrapper, invalidateSpy };
}

describe("useCroppedImageUpload", () => {
  beforeEach(() => {
    mocks.onChange.mockReset();
    mocks.uploadImageDataUrl.mockReset();
    mocks.uploadImageFile.mockReset();
    mocks.validateImageFileForUpload.mockReset();
    mocks.validateImageFileForUpload.mockReturnValue(null);
    mocks.uploadImageFile.mockResolvedValue({ url: "/api/app/assets/svg-logo" });
  });

  it("uploads SVG files directly without opening the crop dialog", async () => {
    const { Wrapper, invalidateSpy } = createWrapper();
    render(<UploadHarness />, { wrapper: Wrapper });

    const file = new File(
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`],
      "logo.svg",
      { type: "image/svg+xml" },
    );
    fireEvent.change(screen.getByTestId("file"), { target: { files: [file] } });

    await waitFor(() => {
      expect(mocks.uploadImageFile).toHaveBeenCalledWith({
        file,
        kind: "logo",
        filename: "logo.svg",
      });
    });

    expect(mocks.uploadImageDataUrl).not.toHaveBeenCalled();
    expect(screen.queryByText("crop-open")).toBeNull();

    await waitFor(() => {
      expect(mocks.onChange).toHaveBeenCalledWith("/api/app/assets/svg-logo");
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: uploadedAssetsQueryKeys.byKind("logo") });
    expect(screen.getByTestId("status").textContent).toBe("idle");
  });

  it("uploads ICO files directly without opening the crop dialog", async () => {
    const { Wrapper } = createWrapper();
    render(<UploadHarness />, { wrapper: Wrapper });

    const file = new File(["\0\0\x01\0"], "logo.ico", { type: "image/x-icon" });
    fireEvent.change(screen.getByTestId("file"), { target: { files: [file] } });

    await waitFor(() => {
      expect(mocks.uploadImageFile).toHaveBeenCalledWith({
        file,
        kind: "logo",
        filename: "logo.ico",
      });
    });

    expect(mocks.uploadImageDataUrl).not.toHaveBeenCalled();
    expect(screen.queryByText("crop-open")).toBeNull();
  });

  it("invalidates uploaded icon assets after a payment-method icon upload succeeds", async () => {
    mocks.uploadImageFile.mockResolvedValueOnce({ url: "/api/app/assets/payment-icon" });
    const { Wrapper, invalidateSpy } = createWrapper();
    render(<UploadHarness kind="icon" />, { wrapper: Wrapper });

    const file = new File(
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`],
      "payment.svg",
      { type: "image/svg+xml" },
    );
    fireEvent.change(screen.getByTestId("file"), { target: { files: [file] } });

    await waitFor(() => {
      expect(mocks.onChange).toHaveBeenCalledWith("/api/app/assets/payment-icon");
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: uploadedAssetsQueryKeys.byKind("icon") });
  });
});

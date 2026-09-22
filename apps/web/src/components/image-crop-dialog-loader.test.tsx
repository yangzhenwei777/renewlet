import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DeferredImageCropDialog } from "./image-crop-dialog-loader";

const moduleGate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/image-crop-dialog", async () => {
  await moduleGate.promise;
  const dialog = await vi.importActual<typeof import("@/components/ui/dialog")>("@/components/ui/dialog");
  return {
    ImageCropDialogContent: () => (
      <>
        <dialog.DialogHeader>
          <dialog.DialogTitle>裁剪图片</dialog.DialogTitle>
          <dialog.DialogDescription>裁剪说明</dialog.DialogDescription>
        </dialog.DialogHeader>
        <div data-testid="image-crop-dialog-real-content">真实裁剪内容</div>
      </>
    ),
  };
});

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "common.loading": "加载中",
      "media.cropTitle": "裁剪图片",
      "media.cropDescription": "裁剪说明",
    }[key] ?? key),
  }),
}));

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <DeferredImageCropDialog
      open={open}
      onOpenChange={setOpen}
      imageSrc="data:image/png;base64,AA=="
      onCropComplete={vi.fn()}
    />
  );
}

describe("DeferredImageCropDialog", () => {
  it("keeps one dialog session while the crop module becomes ready", async () => {
    render(<Harness />);

    const dialog = screen.getByRole("dialog", { name: "裁剪图片" });
    const overlay = document.querySelector("[data-dialog-overlay]");
    expect(dialog).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      moduleGate.release();
      await moduleGate.promise;
    });

    expect(await screen.findByTestId("image-crop-dialog-real-content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "裁剪图片" })).toBe(dialog);
    expect(document.querySelector("[data-dialog-overlay]")).toBe(overlay);
    expect(dialog).not.toHaveAttribute("aria-busy");
  });
});

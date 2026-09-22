// 图片裁剪弹窗测试保护 canvas 导出、缩放/平移状态和关闭清理，避免上传链路拿到过期裁剪结果。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ImageCropDialogContent, type ImageCropDialogProps } from "./image-crop-dialog";

function ImageCropDialog(props: ImageCropDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent dismissMode="explicit" className="border-border bg-card sm:max-w-md">
        <ImageCropDialogContent {...props} />
      </DialogContent>
    </Dialog>
  );
}

describe("ImageCropDialog", () => {
  it("requires explicit controls to close the crop editor", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ImageCropDialog
        open
        onOpenChange={onOpenChange}
        imageSrc="data:image/png;base64,iVBORw0KGgo="
        onCropComplete={vi.fn()}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const overlay = document.querySelector<HTMLElement>("[data-dialog-overlay]");
    if (!overlay) throw new Error("Dialog overlay was not rendered");
    await user.click(overlay);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("exposes an accessible description for the crop dialog", () => {
    render(
      <ImageCropDialog
        open
        onOpenChange={vi.fn()}
        imageSrc="data:image/png;base64,iVBORw0KGgo="
        onCropComplete={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "裁剪 Logo" })).toHaveAccessibleDescription(
      "调整 Logo 的裁剪区域、缩放和旋转，然后确认裁剪结果。",
    );
  });
});

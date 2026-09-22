import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";

describe("DialogModulePending", () => {
  it("announces module loading without adding interactive controls", () => {
    render(
      <Dialog open>
        <DialogContent closeLabel="关闭">
          <DialogHeader>
            <DialogTitle>导入数据</DialogTitle>
            <DialogDescription>选择备份文件</DialogDescription>
          </DialogHeader>
          <DialogModulePending label="正在加载弹窗" />
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "导入数据" });
    const status = within(dialog).getByRole("status", { name: "正在加载弹窗" });
    expect(status).toHaveTextContent("正在加载弹窗");
    expect(within(status).queryByRole("button")).not.toBeInTheDocument();
    expect(within(status).queryByRole("textbox")).not.toBeInTheDocument();
    expect(status.querySelector("svg")).toHaveClass("animate-spin");
  });
});

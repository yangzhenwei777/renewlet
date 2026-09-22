import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { DeferredImportDataDialog } from "./import-data-dialog-loader";

const moduleGate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/import-data-dialog", async () => {
  await moduleGate.promise;
  const dialog = await vi.importActual<typeof import("@/components/ui/dialog")>("@/components/ui/dialog");
  return {
    ImportDataDialogContent: () => (
      <>
        <dialog.DialogHeader>
          <dialog.DialogTitle>导入数据</dialog.DialogTitle>
          <dialog.DialogDescription>导入说明</dialog.DialogDescription>
        </dialog.DialogHeader>
        <div data-testid="import-dialog-real-content">真实导入内容</div>
      </>
    ),
  };
});

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "common.loading": "加载中",
      "import.title": "导入数据",
      "import.description": "导入说明",
    }[key] ?? key),
  }),
}));

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <DeferredImportDataDialog
      open={open}
      onOpenChange={setOpen}
      settings={DEFAULT_SETTINGS}
      config={DEFAULT_CUSTOM_CONFIG}
    />
  );
}

describe("DeferredImportDataDialog", () => {
  it("keeps one dialog session while the import module becomes ready", async () => {
    render(<Harness />);

    const dialog = screen.getByRole("dialog", { name: "导入数据" });
    const overlay = document.querySelector("[data-dialog-overlay]");
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("dialog-module-pending")).toBeInTheDocument();

    await act(async () => {
      moduleGate.release();
      await moduleGate.promise;
    });

    expect(await screen.findByTestId("import-dialog-real-content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "导入数据" })).toBe(dialog);
    expect(document.querySelector("[data-dialog-overlay]")).toBe(overlay);
    expect(dialog).not.toHaveAttribute("aria-busy");
  });
});

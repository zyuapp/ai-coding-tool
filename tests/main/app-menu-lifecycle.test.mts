import assert from "node:assert/strict";
import { test } from "vitest";
import { startMainProcess, waitFor } from "../support/electron-harness.mjs";

type MenuEntry = { label?: string; submenu?: MenuEntry[]; click?: () => void };

test.skipIf(process.platform !== "darwin")("help-menu commands reopen a closed window and show their results without a renderer", async (context) => {
  const main = await startMainProcess(context, "aicodingtool-menu-lifecycle-");
  const menu = main.applicationMenu() as MenuEntry[] | null;
  for (const label of ["Check for Updates…", "Open Source Licenses…"]) {
    const command = menu?.flatMap((entry) => entry.submenu ?? []).find((entry) => entry.label === label);
    assert.ok(command?.click);
    const previousWindow = main.windows[0]!;
    previousWindow.close();
    const dialogsBefore = main.messageBoxes.length;
    command.click();
    await waitFor(() => main.windows.some((window) => window !== previousWindow && window.visible), "replacement app window");
    const reopened = main.windows[0]!;
    assert.equal(reopened.menuBarVisible, true);
    assert.equal(reopened.menuBarAutoHide, false);

    if (label === "Check for Updates…") {
      await waitFor(() => main.messageBoxes.length > dialogsBefore, "the update check showing its result");
      assert.equal(main.messageBoxes.at(-1)?.message, "This copy of AI Coding Tool runs from source.");
    } else {
      await waitFor(() => main.windows.some((window) => window.loadedURL === "aicodingtool-licenses://notices/" && window.visible), "the menu opening licenses");
      main.windows.find((window) => window.loadedURL === "aicodingtool-licenses://notices/")!.close();
    }
  }
});

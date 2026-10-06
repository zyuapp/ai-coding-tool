import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { registered, startMainProcess, tick, waitFor, type MainHarness } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };

function onPlatform<T>(platform: NodeJS.Platform, action: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return action();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

for (const platform of ["darwin", "linux"] as const) {
  test(`${platform}: closing the last window keeps phone access and follows the platform quit behavior`, async (t) => {
    const main = await startMainProcess(t, "aicodingtool-window-close-");
    await waitFor(() => main.appListeners.has("activate"));
    await waitFor(() => main.mobileHost.starts.length === 1);

    onPlatform(platform, () => main.window.close());
    await waitFor(() => main.window.isDestroyed());
    assert.equal(main.windows.length, 0);

    if (platform === "linux") {
      await waitFor(() => main.completedQuits() === 1);
      assert.ok(main.mobileHost.stops() > 0, "quitting stops phone access");
    } else {
      assert.equal(main.quitAttempts(), 0);
      await tick();
      assert.equal(main.mobileHost.stops(), 0, "a Mac with its window closed is still reachable");
      assert.equal(main.mobileHost.starts[0].send({ type: "mobile.request", requestId: "closed", sessionId: "phone", op: "snapshot" }), true, "the runtime answers the phone with no window open");
      registered<() => void>(main.appListeners, "activate")();
      await waitFor(() => main.windows.length === 1);
      assert.notEqual(main.windows[0], main.window);
      assert.equal(main.mobileHost.starts.length, 1, "a window that comes back starts no second bridge");
    }
  });

  test(`${platform}: an update closes the window and finishes shutdown without scheduling a second restart`, async (t) => {
    let main!: MainHarness;
    let finishStop!: () => void;
    let installs = 0;
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: async () => ({ isUpdateAvailable: true }),
      quitAndInstall: (silent: boolean, restart: boolean) => {
        assert.equal(silent, false);
        assert.equal(restart, true);
        installs += 1;
        onPlatform(platform, () => {
          if (platform === "darwin") {
            for (const window of [...main.windows]) window.close();
            if (main.windows.length > 0) return;
          }
          main.app.quit();
        });
      },
    });
    main = await startMainProcess(t, "aicodingtool-update-restart-", {
      updater,
      computerUse: {
        computerUseForRun: async () => ({ status: "setup-required" }),
        computerUsePermissions: async () => ({ accessibility: false, screenRecording: false }),
        requestComputerUsePermission: async () => ({ accessibility: false, screenRecording: false }),
        stopComputerUse: () => new Promise<void>((resolve) => { finishStop = resolve; }),
      },
    });
    await waitFor(() => main.appListeners.has("activate"));
    main.app.isPackaged = true;
    const appImage = process.env.APPIMAGE;
    process.env.APPIMAGE = "/tmp/AI-Coding-Tool.AppImage";
    try {
      onPlatform(platform, () => main.desktop.checkForUpdates());
    } finally {
      if (appImage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = appImage;
    }
    await waitFor(() => updater.listenerCount("update-downloaded") === 1);
    updater.emit("update-downloaded", { version: "0.4.13" });
    onPlatform(platform, () => main.desktop.installUpdate());
    await waitFor(() => main.messageBoxes.some((box) => box.title === "Update ready"));
    assert.equal(installs, 0, "the restart waits for the user to confirm");
    main.dialog.showMessageBox = async () => ({ response: 0 });
    onPlatform(platform, () => main.desktop.installUpdate());
    await waitFor(() => installs === 1);
    assert.equal(main.completedQuits(), 0);

    registered<() => void>(main.appListeners, "activate")();
    await waitFor(() => typeof finishStop === "function", "shutdown reaching computer use");
    finishStop();
    await waitFor(() => main.completedQuits() === 1);
    await waitFor(() => main.mobileHost.stops() > 0);
    assert.equal(main.window.isDestroyed(), true);
    assert.equal(main.relaunches.length, 0);
    assert.equal(installs, 1);
  });
}

test("a Linux package without AppImage uses manual updates", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-manual-update-");
  await waitFor(() => main.appListeners.has("activate"));
  main.app.isPackaged = true;
  const appImage = process.env.APPIMAGE;
  delete process.env.APPIMAGE;
  try {
    onPlatform("linux", () => main.desktop.checkForUpdates());
  } finally {
    if (appImage !== undefined) process.env.APPIMAGE = appImage;
  }
  await waitFor(() => main.messageBoxes.length === 1);
  assert.equal(main.messageBoxes[0].title, "Check for updates manually");
  assert.equal(main.quitAttempts(), 0);
});

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
  test(`${platform}: closing the last window stops phone access and follows the platform quit behavior`, async (t) => {
    const main = await startMainProcess(t, "aicodingtool-window-close-");
    await waitFor(() => main.appListeners.has("activate"));

    onPlatform(platform, () => main.window.close());
    await waitFor(() => main.mobileHost.stops() > 0);
    assert.equal(main.window.isDestroyed(), true);
    assert.equal(main.windows.length, 0);

    if (platform === "linux") {
      await waitFor(() => main.completedQuits() === 1);
    } else {
      assert.equal(main.quitAttempts(), 0);
      registered<() => void>(main.appListeners, "activate")();
      await waitFor(() => main.mobileHost.starts.length === 2);
      assert.equal(main.windows.length, 1);
      assert.notEqual(main.windows[0], main.window);
      const replacement = main.windows[0];
      assert.equal(main.mobileHost.starts[1].send({ type: "mobile.request", requestId: "reopened", sessionId: "phone", op: "snapshot" }), true);
      assert.equal(replacement.webContents.sent.at(-1)?.channel, "mobile:request");
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
    main.dialog.showMessageBox = async () => ({ response: 0 });
    const check = registered<(event: IpcEvent) => void>(main.listeners, "updates:check");
    const appImage = process.env.APPIMAGE;
    process.env.APPIMAGE = "/tmp/AI-Coding-Tool.AppImage";
    try {
      onPlatform(platform, () => check(main.trusted));
    } finally {
      if (appImage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = appImage;
    }
    await waitFor(() => updater.listenerCount("update-downloaded") === 1);
    updater.emit("update-downloaded", { version: "0.4.13" });
    await waitFor(() => installs === 1);
    assert.equal(main.completedQuits(), 0);

    registered<() => void>(main.appListeners, "activate")();
    finishStop();
    await waitFor(() => main.completedQuits() === 1);
    await waitFor(() => main.mobileHost.stops() > 0);
    assert.equal(main.window.isDestroyed(), true);
    assert.equal(main.relaunches.length, 0);
    assert.equal(installs, 1);
  });
}

test("reopening a window waits for phone shutdown before starting phone access again", async (t) => {
  let finishStop!: () => void;
  let stops = 0;
  const main = await startMainProcess(t, "aicodingtool-phone-reopen-", {
    mobileHost: {
      stopMobileHost: async () => {
        stops += 1;
        if (stops === 1) await new Promise<void>((resolve) => { finishStop = resolve; });
      },
    },
  });
  await waitFor(() => main.appListeners.has("activate"));

  onPlatform("darwin", () => main.window.close());
  await waitFor(() => stops === 1);
  registered<() => void>(main.appListeners, "activate")();
  await waitFor(() => main.windows.length === 1);
  await tick();
  assert.equal(main.mobileHost.starts.length, 1);
  assert.equal(main.mobileHost.starts[0].send({ type: "mobile.request", requestId: "old-window", sessionId: "phone", op: "snapshot" }), false);
  const getState = registered<(event: IpcEvent) => Promise<unknown>>(main.handlers, "mobile:state");
  let stateReady = false;
  const state = getState({ sender: main.windows[0].webContents }).then(() => { stateReady = true; });
  await tick();
  assert.equal(stateReady, false);

  finishStop();
  await waitFor(() => main.mobileHost.starts.length === 2);
  await state;
  assert.equal(main.windows[0].isDestroyed(), false);
});

test("a Linux package without AppImage uses manual updates", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-manual-update-");
  await waitFor(() => main.appListeners.has("activate"));
  main.app.isPackaged = true;
  const appImage = process.env.APPIMAGE;
  delete process.env.APPIMAGE;
  try {
    onPlatform("linux", () => registered<(event: IpcEvent) => void>(main.listeners, "updates:check")(main.trusted));
  } finally {
    if (appImage !== undefined) process.env.APPIMAGE = appImage;
  }
  await waitFor(() => main.messageBoxes.length === 1);
  assert.equal(main.messageBoxes[0].title, "Check for updates manually");
  assert.equal(main.quitAttempts(), 0);
});

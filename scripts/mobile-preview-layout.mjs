// @ts-check

/**
 * Fit the window on the monitor while preserving the phone's CSS viewport. Scaling the preview
 * instead of shortening its viewport keeps a small laptop from testing a different phone.
 * @param {boolean} landscape
 * @param {{ width: number, height: number }} workArea
 * @param {{ width: number, height: number }} frame
 */
export function phoneLayout(landscape, workArea, frame) {
  const viewSize = landscape ? { width: 844, height: 390 } : { width: 390, height: 844 };
  const scale = Math.max(0.1, Math.min(1,
    (workArea.width - frame.width - 32) / viewSize.width,
    (workArea.height - frame.height - 32) / viewSize.height,
  ));
  return {
    viewSize,
    scale,
    width: Math.ceil(viewSize.width * scale),
    height: Math.ceil(viewSize.height * scale),
  };
}

/** Electron's emulation API dereferences the render view. A newly created window has none yet.
 * @param {Pick<import("electron").WebContents, "enableDeviceEmulation">} contents
 * @param {ReturnType<typeof phoneLayout>} layout
 * @param {boolean} pageReady
 */
export function emulatePhone(contents, layout, pageReady) {
  if (!pageReady) return;
  contents.enableDeviceEmulation({
    screenPosition: "mobile",
    screenSize: layout.viewSize,
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 3,
    viewSize: layout.viewSize,
    scale: layout.scale,
  });
}

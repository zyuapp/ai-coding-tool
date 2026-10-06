import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, vi } from "vitest";
import type { WebContents } from "electron";

vi.mock("electron", () => ({ protocol: { handle: vi.fn() } }));
const { guardVisualFrames, visualFrameResponse } = await import("../../src/main/visual-frame-host.js");

test("the visual scheme serves only the empty frame, under the frame's own policy", async () => {
  const response = visualFrameResponse("aicodingtool-visual://frame/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy")!, /^default-src 'none'/);
  assert.match(await response.text(), /aicodingtool-visual:render/);

  for (const url of ["aicodingtool-visual://frame/other", "aicodingtool-visual://elsewhere/", "aicodingtool-visual://frame/../etc/passwd"]) {
    assert.equal(visualFrameResponse(url).status, 404, url);
  }
});

test("a frame may load the visual page but never navigate anywhere else, and the window itself is untouched", () => {
  const contents = new EventEmitter();
  guardVisualFrames(contents as unknown as WebContents);
  const navigate = (url: string, isMainFrame: boolean) => {
    let prevented = false;
    contents.emit("will-frame-navigate", { url, isMainFrame, preventDefault: () => { prevented = true; } });
    return prevented;
  };

  assert.equal(navigate("aicodingtool-visual://frame/", false), false);
  assert.equal(navigate("https://example.com/?secret=1", false), true);
  assert.equal(navigate("file:///etc/passwd", false), true);
  assert.equal(navigate("aicodingtool-visual://elsewhere/", false), true);
  assert.equal(navigate("file:///app/renderer/index.html", true), false);
});

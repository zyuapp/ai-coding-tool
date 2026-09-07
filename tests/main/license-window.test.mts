import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { test, vi } from "vitest";

const host = vi.hoisted(() => ({ isPackaged: false, root: "" }));
vi.mock("electron", () => ({
  app: { get isPackaged() { return host.isPackaged; }, getAppPath: () => host.root },
  BrowserWindow: vi.fn(), protocol: { handle: vi.fn() },
}));
const { licenseFiles, licenseResponse } = await import("../../src/main/license-window.js");
const rootUrl = "aicodingtool-licenses://notices/";

test("source and packaged builds expose all shipped documents and render their contents", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-license-test-"));
  const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  context.onTestFinished(async () => {
    if (resources) Object.defineProperty(process, "resourcesPath", resources);
    else Reflect.deleteProperty(process, "resourcesPath");
    await rm(root, { recursive: true, force: true });
  });
  host.root = root;
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: root });
  for (const packaged of [false, true]) {
    host.isPackaged = packaged;
    const directory = path.join(root, packaged ? "legal" : "assets/legal");
    await mkdir(directory, { recursive: true });
    const overview = 'MIT License\nCopyright <Example> & "Contributors"\n';
    await writeFile(path.join(directory, "THIRD-PARTY-NOTICES.txt"), overview);
    await writeFile(path.join(directory, "DEPENDENCIES.html"), "<html><body><h1>Dependency licenses</h1></body></html>");
    await writeFile(path.join(directory, "RENDERER.md"), "# Renderer\nMIT License\n");
    await writeFile(path.join(directory, "ignored.json"), "{}");
    const files = await licenseFiles();
    assert.equal(files.size, 3);
    const response = await licenseResponse(rootUrl, files);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
    const dom = new JSDOM(await response.text());
    assert.equal(dom.window.document.querySelector("pre")?.textContent, overview);
    assert.equal(dom.window.document.querySelectorAll("nav a").length, 3);
    assert.equal(dom.window.document.querySelector('[aria-current="page"]')?.textContent, "Overview");
    dom.window.close();

    const html = new JSDOM(await (await licenseResponse(`${rootUrl}DEPENDENCIES.html`, files)).text());
    assert.equal(html.window.document.querySelector("iframe")?.src, `${rootUrl}raw/DEPENDENCIES.html`);
    html.window.close();
    assert.match(await (await licenseResponse(`${rootUrl}raw/DEPENDENCIES.html`, files)).text(), /<h1>Dependency licenses<\/h1>/);
    assert.match(await (await licenseResponse(`${rootUrl}RENDERER.md`, files)).text(), /# Renderer\nMIT License/);

    for (const url of [`${rootUrl}ignored.json`, `${rootUrl}..%2Fsecret.txt`, "file:///etc/passwd", "aicodingtool-licenses://elsewhere/THIRD-PARTY-NOTICES.txt"]) {
      assert.equal((await licenseResponse(url, files)).status, 404);
    }
    await rm(path.join(directory, "THIRD-PARTY-NOTICES.txt"));
    assert.equal((await licenseResponse(rootUrl, files)).status, 500, "a missing document displays an error");
  }
});

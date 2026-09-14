/* Run after tsc -p tsconfig.main.json: electron tests/electron/remote-browser.cjs */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, webContents, ipcMain } = require('electron');

const build = process.env.AIC_BROWSER_TEST_BUILD || path.join(__dirname, '../../dist/main');
const browser = require(path.join(build, 'main/browser-host.js'));
const { reduce } = require(path.join(build, 'application/workspace-reducer.js'));
const { emptyWorkspaceState } = require(path.join(build, 'application/workspace-state.js'));
const { isBrowserFrame } = require(path.join(build, 'contracts/browser-control.js'));

async function until(check) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Browser test timed out');
}

async function prepareViewer(folder, client, tabId, url) {
  const { build: buildRenderer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  await buildRenderer({ configFile: false, publicDir: false, logLevel: 'warn', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react()], build: {
    outDir: path.join(folder, 'renderer'), emptyOutDir: true,
    lib: { entry: path.join(__dirname, 'browser-panel.tsx'), name: 'BrowserPanelTest', formats: ['iife'], fileName: () => 'panel.js', cssFileName: 'panel' },
  } });
  ipcMain.handle('browser-test:read', () => client.query({ kind: 'browser-frame', tabId }));
  ipcMain.handle('browser-test:send', async (_event, input) => {
    const result = await client.send([input]);
    if (!result.ok) throw new Error(result.message);
  });
  const preload = path.join(folder, 'preload.cjs');
  await writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('browserTest',{
    tabId:${JSON.stringify(tabId)},url:${JSON.stringify(url)},read:()=>ipcRenderer.invoke('browser-test:read'),send:input=>ipcRenderer.invoke('browser-test:send',input)});`);
  await writeFile(path.join(folder, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="panel.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}.browser-panel{flex:1}</style><div id="root"></div><script src="panel.js"></script>');
  return preload;
}

async function test() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'aic-browser-control-'));
  app.setPath('userData', path.join(folder, 'profile'));
  await app.whenReady();
  const { MobileServer, WORKSPACE_SOCKET_PATH } = await import(path.join(build, 'main/mobile/mobile-server.mjs'));
  const { PairingStore } = await import(path.join(build, 'main/mobile/pairing.mjs'));
  const { createComputerClient } = await import(path.join(build, 'main/computers/computer-client.mjs'));
  const page = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Remote browser test</title><style>body{font:20px sans-serif;background:#fafafa}input,button{font:inherit;padding:10px}section{height:2500px}</style>
      <h1>Remote browser test</h1><form onsubmit="event.preventDefault();document.title='submitted'"><input aria-label="Message"><button>Submit</button></form>
      <button id="click" onclick="this.textContent='Clicked';window.clicked=event.isTrusted">Click me</button><a href="/next">Next</a><section></section>
      <script>sessionStorage.setItem('retained', sessionStorage.getItem('retained')||'yes');window.loads=(sessionStorage.loads=Number(sessionStorage.loads||0)+1);</script>`);
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${page.address().port}/`;
  const host = new BrowserWindow({ show: false });
  let viewer;
  let state = emptyWorkspaceState();
  let revision = 0;
  const listeners = new Set();
  async function dispatch(input) {
    const next = reduce(state, input);
    state = next.state;
    revision++;
    for (const listener of listeners) listener({ revision, state });
    try {
      for (const effect of next.effects) {
        if (effect.type === 'browser.permissions') browser.configurePermissions(effect.permissions);
        if (effect.type === 'browser.open') browser.openTab(effect.tabId, effect.url, effect.taskId, effect.offscreen);
        if (effect.type === 'browser.navigate') browser.navigate(effect.tabId, effect.url, effect.taskId);
        if (effect.type === 'browser.show') browser.showTab(effect.tabId);
        if (effect.type === 'browser.viewport') await browser.setRemoteViewport(effect.tabId, effect.viewport);
        if (effect.type === 'browser.control') await browser.controlPage(effect.tabId, effect.epoch, effect.input);
        if (effect.type === 'browser.close') browser.closeTab(effect.tabId);
      }
      return { ...(next.result ?? { ok: true }), revision };
    } catch (error) { return { ok: false, message: String(error), revision }; }
  }
  browser.startBrowserHost(host, { onPage: event => { void dispatch({ type: 'browser.updated', page: event }); }, onFind() {}, onKey() { return false; } });
  const devices = new PairingStore(path.join(folder, 'devices.json'));
  await writeFile(path.join(folder, 'index.html'), '<!doctype html>');
  const server = new MobileServer({
    devices, staticRoot: folder, port: 0, allowedOrigins: () => [], snapshot: async () => null, command: async () => {}, query: async () => null, onChange() {},
    workspace: {
      snapshot: () => ({ revision, state }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      input: async inputs => { let result; for (const input of inputs) { result = await dispatch(input); if (!result.ok) return result; } return result; },
      query: query => browser.captureRemoteFrame(query.tabId),
    },
  });
  await server.start('127.0.0.1');
  let deviceId = '';
  let connections = 0;
  const client = createComputerClient({
    host: '127.0.0.1', url: `ws://127.0.0.1:${server.port}${WORKSPACE_SOCKET_PATH}`, deviceName: 'Browser test',
    credential: { code: devices.mint(Date.now()).code }, onPaired: id => { deviceId = id; }, onState() {},
    onStatus: status => { if (status === 'connected') connections++; },
  });
  try {
    await until(() => client.status === 'connected');
    assert.equal((await client.send([{ type: 'browser.open', url }])).ok, true);
    await until(() => client.state?.docks.draft?.browserTabs[0]?.loading === false);
    const native = webContents.getAllWebContents().find(contents => contents.getURL() === url);
    await native.executeJavaScript('document.cookie="login=test";document.querySelector("input").value="Keep this native page"');
    assert.equal((await client.send([{ type: 'browser.open', url, newTab: true, offscreen: true }])).ok, true);
    await until(() => client.state?.docks.draft?.browserTabs[1]?.loading === false);
    const tabId = client.state.docks.draft.browserTabs[1].id;
    const wc = webContents.getAllWebContents().find(contents => contents.id !== native.id && contents.getURL() === url);
    assert.ok(wc);
    assert.equal(await wc.executeJavaScript('document.cookie'), 'login=test');
    assert.equal(await native.executeJavaScript('document.querySelector("input").value'), 'Keep this native page');
    // This emulates a native panel being hidden when another window views its tab remotely.
    browser.setBounds({ x: 0, y: 0, width: 700, height: 500 });
    assert.equal((await client.send([{ type: 'browser.viewport', tabId, viewport: { width: 800, height: 600 } }])).ok, true);
    const read = async () => {
      const frame = await client.query({ kind: 'browser-frame', tabId });
      assert.ok(isBrowserFrame(frame) && frame);
      return frame;
    };
    const started = Date.now();
    let frame = await read();
    console.log('First frame:', Date.now() - started, 'ms,', frame.data.length, 'base64 bytes');
    const send = async input => {
      const result = await client.send([{ type: 'browser.control', tabId, epoch: frame.epoch, input }]);
      assert.equal(result.ok, true, result.message);
    };
    const click = async selector => {
      const point = await wc.executeJavaScript(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()`);
      for (const phase of ['down', 'up']) await send({ kind: 'pointer', phase, ...point, button: 'left', buttons: phase === 'down' ? 1 : 0, clicks: 1, modifiers: 0 });
    };
    frame = await read();
    await click('input');
    await send({ kind: 'text', text: 'Typed from paired computer' });
    assert.equal(await wc.executeJavaScript('document.querySelector("input").value'), 'Typed from paired computer');
    for (const phase of ['down', 'up']) await send({ kind: 'key', phase, key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0, repeat: false });
    assert.equal(wc.getTitle(), 'submitted');
    await click('#click');
    assert.equal(await wc.executeJavaScript('window.clicked'), true);
    frame = await read();
    if (process.env.AIC_BROWSER_TEST_SHOT) await writeFile(process.env.AIC_BROWSER_TEST_SHOT, Buffer.from(frame.data, 'base64'));
    await send({ kind: 'wheel', x: 300, y: 300, deltaX: 0, deltaY: 500, modifiers: 0 });
    await until(async () => (await wc.executeJavaScript('scrollY')) > 0);
    const oldEpoch = frame.epoch;
    await client.send([{ type: 'browser.viewport', tabId, viewport: { width: 1000, height: 700 } }]);
    frame = await read();
    assert.equal(frame.height, 700);
    assert.notEqual(frame.epoch, oldEpoch);
    assert.equal((await client.send([{ type: 'browser.control', tabId, epoch: oldEpoch, input: { kind: 'text', text: 'stale' } }])).ok, false);
    const loads = await wc.executeJavaScript('window.loads');
    server.dropDevice(deviceId);
    await until(() => connections === 2);
    frame = await read();
    assert.equal(await wc.executeJavaScript('window.loads'), loads);
    assert.equal(await wc.executeJavaScript('sessionStorage.retained'), 'yes');
    assert.equal(BrowserWindow.getFocusedWindow(), null);
    console.log('Rendering the real browser panel…');
    const preload = await prepareViewer(folder, client, tabId, url);
    await wc.executeJavaScript('scrollTo(0,0)');
    viewer = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true, preload } });
    viewer.webContents.on('console-message', event => console.log('Viewer:', event.message));
    await viewer.loadFile(path.join(folder, 'renderer/index.html'));
    await until(async () => viewer.webContents.executeJavaScript('document.querySelector("canvas")?.width > 300 && !document.querySelector(".remote-browser-status")'));
    viewer.webContents.debugger.attach('1.3');
    await viewer.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const target = await wc.executeJavaScript('(() => {const r=document.querySelector("input").getBoundingClientRect();return {x:r.x+20,y:r.y+20,width:innerWidth,height:innerHeight}})()');
    const point = await viewer.webContents.executeJavaScript(`(() => {const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+${target.x}/${target.width}*r.width,y:r.y+${target.y}/${target.height}*r.height}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await viewer.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await until(async () => wc.executeJavaScript('document.activeElement.tagName === "INPUT"'));
    await viewer.webContents.debugger.sendCommand('Input.insertText', { text: ' via canvas' });
    await until(async () => (await wc.executeJavaScript('document.querySelector("input").value')).includes(' via canvas'));
    if (process.env.AIC_BROWSER_TEST_SHOT) await writeFile(process.env.AIC_BROWSER_TEST_SHOT, (await viewer.webContents.capturePage()).toPNG());
    viewer.destroy(); viewer = undefined;
    await new Promise(resolve => setTimeout(resolve, 5_500));
    await assert.rejects(read(), /Reconnect/, 'closing the panel lets its rendering lease expire');
    await client.send([{ type: 'browser.viewport', tabId, viewport: { width: 800, height: 600 } }]);
    await read();
    await client.send([{ type: 'browser.viewport', tabId, viewport: null }]);
    await assert.rejects(read(), /Reconnect/);
    assert.equal(await native.executeJavaScript('document.querySelector("input").value'), 'Keep this native page');
    console.log('PASS: shared login cookies, preserved native page, paired navigation, hidden capture, trusted click, typing, Enter, scrolling, resizing, stale-input rejection, reconnect, session preservation, real browser panel input, lease expiry, and no host focus.');
  } finally {
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    ipcMain.removeHandler('browser-test:read'); ipcMain.removeHandler('browser-test:send');
    client.stop(); await server.stop(); browser.stopBrowserHost(); host.destroy();
    await new Promise(resolve => page.close(resolve)); await rm(folder, { recursive: true, force: true });
  }
}
const timeout = setTimeout(() => { console.error('Browser integration test timed out'); app.exit(2); }, 40_000);
app.on('window-all-closed', () => {});
test().then(() => { clearTimeout(timeout); app.quit(); }, error => { console.error(error); app.exit(1); });

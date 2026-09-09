import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { isScreenshotContext } from "../../src/domain/screenshot-context.ts";

// Run explicitly on a Mac with Accessibility and Screen Recording grants, outside the sandbox:
// AIC_NATIVE_SCREENSHOT_TEST=1 npx vitest run tests/main/screenshot-context-native.test.mts
const fixture = String.raw`
const {app, BrowserWindow} = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'fixture-data'));
app.whenReady().then(async () => {
  const decoy = new BrowserWindow({show:false,width:400,height:250});
  await decoy.loadURL('data:text/html,' + encodeURIComponent('<title>Other window</title><p>PRIVATE-SIBLING-9276</p>'));
  decoy.showInactive();
  const win = new BrowserWindow({show:false,width:600,height:400});
  await win.loadURL('data:text/html,' + encodeURIComponent(
    '<title>Screenshot acceptance</title><h1>VISIBLE-9276</h1>' +
    '<p>Password reset instructions remain readable.</p>' +
    '<textarea aria-label="Checklist">Before list\n- preserve this item\nAfter list</textarea>' +
    '<label><input type="checkbox" checked>Checked option</label>' +
    '<label><input type="checkbox" checked disabled>Disabled option</label>' +
    '<input aria-label="Secret entry" type="password" value="PRIVATE-PASSWORD-9276">' +
    '<div role="dialog" aria-label="Settings"><p>Nested dialog content</p></div>' +
    '<div style="height:1500px"></div><p>OFFSCREEN-9276</p>'
  ));
  win.show(); app.focus({steal:true});
  setTimeout(() => process.send({ready:true}), 1000);
}).catch(error => {console.error(error);app.exit(1)});
`;

const capture = String.raw`
const {app} = require('electron');
const {spawn} = require('node:child_process');
const {writeFile} = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[2];
const {captureFrontmostWindow} = require(path.join(root,'dist/main/main/window-screenshot.js'));
const {writeAttachment,readAttachmentContext} = require(path.join(root,'dist/main/main/attachment-store.js'));
const {promptWithAttachments} = require(path.join(root,'dist/main/application/attachments.js'));
app.setPath('userData',path.join(__dirname,'capture-data'));
let child;
app.whenReady().then(async () => {
  child = spawn(process.execPath,[path.join(__dirname,'fixture.cjs')],{stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error('Native fixture did not become ready')),10000);
    child.once('message',()=>{clearTimeout(timer);resolve()});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Native fixture exited'))});
  });
  const results=[];
  for (let i=0;i<3;i++) {
    const started=Date.now();
    let ticks=0;
    const heartbeat=setInterval(()=>ticks++,10);
    let shot;
    try {shot=await captureFrontmostWindow(false)} finally {clearInterval(heartbeat)}
    assert.ok(ticks>0,'native capture must leave the main event loop responsive');
    assert.equal(shot.status,'captured');
    assert.equal(shot.title,'Screenshot acceptance');
    assert.equal(shot.context.accessibility.status,'captured');
    const text=shot.context.accessibility.text;
    for (const marker of ['VISIBLE-9276','OFFSCREEN-9276','preserve this item','After list','Password reset instructions','Nested dialog content']) assert.ok(text.includes(marker),marker + ': ' + text);
    assert.ok(!text.includes('PRIVATE-SIBLING-9276'));
    assert.ok(!text.includes('PRIVATE-PASSWORD-9276'));
    assert.ok(text.includes('Checked option'));
    // Some Electron modes expose checkbox labels but omit their numeric AXValue; do not infer it.
    assert.ok(text.includes('Disabled option'));
    const file=await writeAttachment(shot.png,shot.context);
    const context=await readAttachmentContext(file);
    assert.deepEqual(context,shot.context);
    const copy=await writeAttachment(shot.png,context);
    assert.deepEqual(await readAttachmentContext(copy),context);
    const prompt=promptWithAttachments('Explain the screenshot',[{path:copy,labels:[],context}]);
    assert.ok(prompt.includes('OFFSCREEN-9276'));
    results.push({ms:Date.now()-started,context,file,prompt});
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await writeFile(path.join(__dirname,'result.json'),JSON.stringify(results));
  child.kill(); app.quit();
}).catch(error=>{console.error(error);child?.kill();app.exit(1)});
`;

test("native window capture retains offscreen content through saved attachments and the prompt", {
  skip: process.platform !== "darwin" || process.env.AIC_NATIVE_SCREENSHOT_TEST !== "1", timeout: 30_000,
}, async () => {
  const root = process.cwd();
  const directory = await mkdtemp(path.join(os.tmpdir(), "aic-native-screenshot-"));
  try {
    await writeFile(path.join(directory, "fixture.cjs"), fixture);
    await writeFile(path.join(directory, "capture.cjs"), capture);
    await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"));
    await promisify(execFile)(path.join(root, "node_modules", ".bin", "electron"), [path.join(directory, "capture.cjs"), root], { timeout: 25_000 });
    const results: Array<{ ms: number; context: unknown; file: string; prompt: string }> = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.ok(isScreenshotContext(result.context));
      assert.match(result.prompt, /OFFSCREEN-9276/);
      assert.ok(result.ms < 5000);
      assert.equal((await readFile(result.file)).subarray(1, 4).toString(), "PNG");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

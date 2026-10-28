const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {HANDOFF_PROTOCOL} = require('../capture/core.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const capture = {kind: 'douban', sourceKey: 'movie.douban.com:1300267', draft: {url: 'https://movie.douban.com/subject/1300267/', metadata: {title: '乱世佳人', type: 1}}, warnings: []};

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Popup did not settle');
}

async function popup(protocolAt = () => HANDOFF_PROTOCOL) {
  const dom = new JSDOM(read('popup.html'), {url: 'https://extension.test/popup.html', runScripts: 'outside-only'});
  const w = dom.window, calls = [], scripts = [];
  const close = w.close.bind(w);
  let configReads = 0, closed = false;
  w.close = () => { closed = true; };
  w.chrome = {
    runtime: {sendMessage: async message => {
      calls.push(structuredClone(message));
      if (message.type === 'DOUBAN_AUTO_SETTINGS_GET') return {success: true, data: {enabled: false}};
      if (message.type === 'CAPTURE_CONFIG_GET') return {success: true, data: {base: 'https://api.test.invalid/api', configured: true, handoffProtocol: protocolAt(++configReads)}};
      if (message.type === 'CAPTURE_OPEN') return {success: true, data: {id: 'capture-transfer'}};
      throw new Error('Unexpected message: ' + message.type);
    }},
    tabs: {query: async () => [{id: 7, title: '乱世佳人 (豆瓣)', url: capture.draft.url}]},
    scripting: {executeScript: async options => { scripts.push(options); return options.files ? [] : [{result: structuredClone(capture)}]; }}
  };
  w.eval(read('shared/config.js'));
  w.eval(read('capture/core.js'));
  w.eval(read('popup.js'));
  await until(() => !w.document.querySelector('#capture-page').disabled);
  return {dom, calls, scripts, close, get closed() { return closed; }};
}

test('capture rechecks background protocol before extracting a page or opening the editor', async () => {
  for (const protocol of [undefined, 'obsolete']) {
    const ctx = await popup(read => read === 1 ? HANDOFF_PROTOCOL : protocol);
    try {
      const doc = ctx.dom.window.document;
      doc.querySelector('#capture-page').click();
      await until(() => doc.querySelector('#status').textContent.includes('chrome://extensions'));
      assert.match(doc.querySelector('#status').textContent, /重新加载 AIO Life.*来源页面重新采集/);
      assert.equal(ctx.calls.filter(message => message.type === 'CAPTURE_CONFIG_GET').length, 2);
      assert.equal(ctx.calls.some(message => message.type === 'CAPTURE_OPEN'), false);
      assert.equal(ctx.scripts.length, 0);
      assert.equal(doc.querySelector('#capture-page').disabled, false);
      assert.equal(ctx.closed, false);
    } finally { ctx.close(); }
  }
});

test('current capture protocol extracts Douban data and opens one editor', async () => {
  const ctx = await popup();
  try {
    ctx.dom.window.document.querySelector('#capture-page').click();
    await until(() => ctx.closed);
    assert.equal(ctx.calls.filter(message => message.type === 'CAPTURE_CONFIG_GET').length, 2);
    assert.deepEqual(ctx.calls.filter(message => message.type === 'CAPTURE_OPEN'), [{type: 'CAPTURE_OPEN', capture}]);
    assert.equal(ctx.scripts.length, 2);
    assert(ctx.scripts.every(options => options.target.tabId === 7));
  } finally { ctx.close(); }
});

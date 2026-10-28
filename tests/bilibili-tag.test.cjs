const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const tags = [
  ['待看', 'not_started'],
  ['已看', 'completed'],
  ['学习中', 'in_progress'],
  ['暂停', 'on_hold']
];

function worker({ ok = true, result = { code: 0, data: null } } = {}) {
  const calls = [];
  let listener;
  const context = vm.createContext({
    console: { log() {}, error() {} },
    URL, TextEncoder, crypto: webcrypto, AbortSignal, FormData,
    chrome: {
      storage: { local: { get: async () => ({ authToken: 'TEST-ONLY-TOKEN', apiBaseUrl: 'https://api.test.invalid/api' }) } },
      runtime: { onMessage: { addListener: fn => listener = fn } }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('https://api.bilibili.com/')) {
        return { ok: true, json: async () => ({ code: 0, data: {
          title: '测试视频', pic: 'https://i0.hdslb.com/test.jpg',
          duration: 200, videos: 2, owner: { name: '测试作者' },
          pages: [{ page: 1, duration: 100 }, { page: 2, duration: 100 }]
        } }) };
      }
      assert.equal(url, 'https://api.test.invalid/api/b-video/tagVideo');
      return { ok, json: async () => result };
    }
  });
  for (const file of ['shared/config.js', 'shared/api.js', 'bilibili/background.js']) vm.runInContext(read(file), context, {filename: file});
  return {
    calls,
    send: message => new Promise(resolve => listener(message, {}, resolve)),
    tag(tag) { return this.send({ type: 'SYNC_TAG', data: { bvid: 'BVtarget', tag, p: '2', currentTime: 25 } }); }
  };
}

for (const [tag, status] of tags) {
  test(`标记${tag}发送当前字符串状态及 DTO 字段，保留分 P 与累计观看时长`, async () => {
    const app = worker();
    const response = await app.tag(tag);
    assert.equal(response.success, true);
    assert.equal(response.data.totalProgress, 63);
    const request = app.calls.at(-1);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.redirect, 'follow');
    assert.equal(request.options.signal, undefined);
    assert.deepEqual(JSON.parse(request.options.body), {
      bvid: 'BVtarget', title: '测试视频', url: 'https://bilibili.com/video/BVtarget?p=2',
      cover: 'https://i0.hdslb.com/test.jpg', duration: 200, episodes: 2,
      currentEpisode: 2, status, notes: '', ownerName: '测试作者', watchedDuration: 125
    });
  });
}

test('未知标记和无对应字段的收藏在请求前拒绝', async () => {
  for (const tag of ['收藏', '不存在', undefined, 'toString']) {
    const app = worker();
    assert.equal((await app.tag(tag)).success, false);
    assert.equal(app.calls.length, 0);
  }
});

test('标记接口的 HTTP、业务、异常响应和重复添加均向调用方返回失败', async () => {
  for (const options of [
    { ok: false },
    { result: { code: 100400, message: '请求体格式错误' } },
    { result: { code: '0' } },
    { result: {} },
    { result: { code: 0, data: false } },
    { result: { code: 100001, message: '该视频已存在，无法重复添加' } }
  ]) {
    const app = worker(options);
    const response = await app.tag('待看');
    assert.equal(response.success, false);
    assert.equal(response.error, options.result?.message || '标记视频失败');
    assert.equal(app.calls.length, 2, '不自动重试写入或改为更新已有视频');
  }
});

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('UI did not settle');
}

async function popup(app) {
  const dom = new JSDOM(read('popup.html'), { url: 'https://extension.test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = {
    runtime: { sendMessage: async message => {
      if (message.type === 'DOUBAN_AUTO_SETTINGS_GET') return { success: true, data: { enabled: false } };
      if (message.type === 'CAPTURE_CONFIG_GET') return { success: true, data: { base: 'https://api.test.invalid/api', configured: true } };
      return app.send(message);
    } },
    tabs: { query: async () => [{ id: 1, title: '测试视频', url: 'https://www.bilibili.com/video/BVtarget?p=2' }] }
  };
  w.eval(read('shared/config.js'));
  w.eval(read('capture/core.js'));
  w.eval(read('popup.js'));
  await until(() => !w.document.querySelector('.tag-item').disabled);
  return dom;
}

test('弹窗四种状态经真实后台脚本生成正确请求，成功后展示所选状态', async () => {
  for (const [tag, status] of tags) {
    const app = worker();
    const dom = await popup(app);
    try {
      const doc = dom.window.document;
      assert.deepEqual([...doc.querySelectorAll('.tag-item')].map(item => item.dataset.tag), tags.map(([label]) => label));
      const button = doc.querySelector(`[data-tag="${tag}"]`);
      button.click();
      assert.equal(button.getAttribute('aria-busy'), 'true');
      button.click();
      await until(() => doc.querySelector('#status').textContent === `已同步为「${tag}」`);
      assert.equal(app.calls.length, 2, '请求中重复点击不产生额外写入');
      assert.equal(JSON.parse(app.calls.at(-1).options.body).status, status);
      assert.equal(button.classList.contains('is-selected'), true);
    } finally { dom.window.close(); }
  }
});

test('弹窗标记失败展示后端原因，恢复按钮并允许用户重试', async () => {
  const app = worker({ result: { code: 100400, message: '参数校验失败' } });
  const dom = await popup(app);
  try {
    const doc = dom.window.document;
    const button = doc.querySelector('[data-tag="待看"]');
    button.click();
    await until(() => doc.querySelector('#status').textContent === '参数校验失败');
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.equal(button.classList.contains('is-selected'), false);
    button.click();
    await until(() => app.calls.length === 3 && !button.disabled);
    assert.equal(JSON.parse(app.calls.at(-1).options.body).status, 'not_started');
  } finally { dom.window.close(); }
});

test('B站页面菜单与弹窗状态一致，点击后经后台发送正确状态', async () => {
  for (const [tag, status] of tags) {
    const app = worker();
    const dom = new JSDOM('<ul class="more-ops-list"></ul>', {
      url: 'https://www.bilibili.com/video/BVtarget?p=2', runScripts: 'outside-only'
    });
    const w = dom.window;
    const observers = [];
    w.MutationObserver = class extends w.MutationObserver {
      constructor(callback) { super(callback); observers.push(this); }
    };
    w.console = { log() {}, error() {} };
    w.chrome = { runtime: { sendMessage: (message, callback) => {
      if (message.type === 'SYNC_PROGRESS') callback({ success: true, data: { code: 0, skipped: true } });
      else app.send(message).then(callback);
    } } };
    try {
      w.eval(read('bilibili/content.js'));
      await until(() => w.document.querySelector('.aiolife-sub-item'));
      assert.deepEqual([...w.document.querySelectorAll('.aiolife-sub-item')].map(item => item.dataset.tag), tags.map(([label]) => label));
      w.document.querySelector(`[data-tag="${tag}"]`).click();
      await until(() => w.document.querySelector('.aiolife-toast')?.textContent.includes(`已标记为「${tag}」`));
      assert.equal(JSON.parse(app.calls.at(-1).options.body).status, status);
    } finally {
      observers.forEach(observer => observer.disconnect());
      w.close();
    }
  }
});

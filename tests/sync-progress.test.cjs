const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../background.js'), 'utf8');

function background({ token = 'test-token', pages = [{ items: [], total: 0 }], queryCode = 0, syncCode = 0, syncData = null, queryOk = true, syncOk = true } = {}) {
  const calls = [];
  let listener;
  const context = vm.createContext({
    console: { log() {}, error() {} },
    // The capture worker has separate transport tests. Keep these tests focused on Bilibili.
    importScripts() {},
    captureConfig: async () => ({ base: 'https://aiolife.top/api' }),
    chrome: {
      storage: { local: { get: async () => ({ authToken: token }) } },
      runtime: { onMessage: { addListener: fn => listener = fn } }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/query')) {
        return { ok: queryOk, json: async () => ({ code: queryCode, data: pages[Number(parsed.searchParams.get('page')) - 1] }) };
      }
      if (parsed.hostname === 'api.bilibili.com') {
        return { ok: true, json: async () => ({ code: 0, data: { duration: 200, pages: [{ page: 1, duration: 100 }, { page: 2, duration: 100 }] } }) };
      }
      if (parsed.pathname.endsWith('/syncProgress')) {
        return { ok: syncOk, json: async () => ({ code: syncCode, data: syncData }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });
  vm.runInContext(source, context);
  return { calls, sync: () => new Promise(resolve => listener({ type: 'SYNC_PROGRESS', data: { bvid: 'BVtarget', p: '2', currentTime: 25 } }, {}, resolve)) };
}

const marked = { items: [{ bvid: 'BVtarget' }], total: 1 };

test('未配置 Token 时不查询、不同步', async () => {
  const app = background({ token: '' });
  const response = await app.sync();
  assert.equal(response.data.skipped, true);
  assert.equal(app.calls.length, 0);
});

test('空列表或只有其他视频时静默跳过，不调用写入接口', async () => {
  for (const page of [{ items: [], total: 0 }, { items: [{ bvid: 'BVother' }], total: 1 }]) {
    const app = background({ pages: [page] });
    assert.equal((await app.sync()).data.skipped, true);
    assert.equal(app.calls.length, 1);
    assert.match(app.calls[0].url, /\/query\?/);
  }
});

test('服务端已有记录才同步，保留分 P 和累计观看时长', async () => {
  const app = background({ pages: [marked] });
  const response = await app.sync();
  assert.equal(response.success, true);
  assert.equal(response.data.skipped, false);
  assert.equal(response.data.totalProgress, 63);
  const write = app.calls.at(-1);
  assert.equal(write.options.method, 'POST');
  assert.deepEqual(JSON.parse(write.options.body), { bvid: 'BVtarget', currentEpisode: 2, watchedDuration: 125 });
});

test('匹配后续分页中的视频，支持 total 为字符串或 null', async () => {
  for (const total of ['101', null]) {
    const app = background({ pages: [{ items: Array.from({ length: 100 }, (_, i) => ({ bvid: `BVother${i}` })), total }, { items: [{ bvid: 'BVtarget' }], total }] });
    assert.equal((await app.sync()).data.skipped, false);
    assert.match(app.calls[1].url, /page=2&/);
  }
});

test('列表查询失败或响应异常时不进行写入', async () => {
  for (const options of [{ queryCode: 401 }, { queryOk: false }, { pages: [{}] }]) {
    const app = background(options);
    assert.equal((await app.sync()).success, false);
    assert.equal(app.calls.length, 1);
  }
});

test('HTTP 或业务失败不能伪装成同步成功', async () => {
  for (const options of [{ syncCode: 113000 }, { syncOk: false }, { syncData: false }]) {
    const app = background({ pages: [marked], ...options });
    assert.equal((await app.sync()).success, false);
  }
});

test('重新读取服务端记录，删除标记后不继续同步', async () => {
  const pages = [marked];
  const app = background({ pages });
  assert.equal((await app.sync()).data.skipped, false);
  pages[0] = { items: [], total: 0 };
  const before = app.calls.length;
  assert.equal((await app.sync()).data.skipped, true);
  assert.equal(app.calls.length - before, 1);
});

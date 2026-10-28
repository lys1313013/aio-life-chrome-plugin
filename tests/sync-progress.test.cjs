const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const sources = ['shared/config.js', 'shared/api.js', 'bilibili/background.js'].map(file => ({file, source: readFileSync(path.join(__dirname, '..', file), 'utf8')}));

const BVID = 'BV1AbCdEfGh2';

function background({ token = 'test-token', lookup = { data: null }, queryCode = 0, syncCode = 0, syncData = null, queryOk = true, syncOk = true, storageGet } = {}) {
  const calls = [];
  let listener;
  const context = vm.createContext({
    console: { log() {}, error() {} },
    URL, TextEncoder, crypto: webcrypto, AbortSignal, FormData,
    chrome: {
      storage: { local: { get: storageGet || (async () => ({ authToken: token })) } },
      runtime: { onMessage: { addListener: fn => listener = fn } }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/by-bvid')) {
        assert.equal(parsed.searchParams.get('bvid'), BVID);
        assert.deepEqual([...parsed.searchParams.keys()], ['bvid']);
        return { ok: queryOk, json: async () => ({ code: queryCode, ...lookup }) };
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
  for (const {file, source} of sources) vm.runInContext(source, context, {filename: file});
  return {
    calls,
    send: message => new Promise(resolve => listener(message, {}, resolve)),
    sync(bvid = BVID) { return this.send({ type: 'SYNC_PROGRESS', data: { bvid, p: '2', currentTime: 25 } }); }
  };
}

const marked = { id: '9007199254740993', bvid: BVID, currentEpisode: 1, watchedDuration: 10 };

test('未配置 Token 时不查询、不同步', async () => {
  const app = background({ token: '' });
  const response = await app.sync();
  assert.equal(response.data.skipped, true);
  assert.equal(app.calls.length, 0);
});

test('未标记时仅精确查询一次，不调用写入接口', async () => {
  const app = background();
  assert.equal((await app.sync()).data.skipped, true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, `https://aiolife.top/api/b-video/by-bvid?bvid=${BVID}`);
});

test('服务端已有记录才同步，保留分 P 和累计观看时长', async () => {
  const app = background({ lookup: {data: marked} });
  const response = await app.sync();
  assert.equal(response.success, true);
  assert.equal(response.data.skipped, false);
  assert.equal(response.data.totalProgress, 63);
  const write = app.calls.at(-1);
  assert.equal(write.options.method, 'POST');
  assert.deepEqual(JSON.parse(write.options.body), { bvid: BVID, currentEpisode: 2, watchedDuration: 125 });
});

test('GET_PROGRESS 返回精确记录及字符串 ID，不扫描列表', async () => {
  const app = background({ lookup: {data: marked} });
  const response = await app.send({ type: 'GET_PROGRESS', bvid: BVID });
  assert.equal(response.success, true);
  assert.deepEqual(response.data, marked);
  assert.equal(app.calls.length, 1);
});

test('精确查询失败或响应异常时不进行写入，也不回退分页扫描', async () => {
  for (const options of [
    { queryCode: 401 }, { queryCode: '0' }, { queryOk: false }, { lookup: {} },
    { lookup: {data: {}} }, { lookup: {data: []} }, { lookup: {data: {items: [marked]}} },
    { lookup: {data: {bvid: 'BV1aBcDeFgH2'}} }
  ]) {
    const app = background(options);
    assert.equal((await app.sync()).success, false);
    assert.equal(app.calls.length, 1);
  }
});

test('非法 BV 号在请求前拒绝', async () => {
  for (const bvid of ['', 'BVtarget', 'bv1AbCdEfGh2', BVID + '&userId=8', null]) {
    const app = background();
    assert.equal((await app.sync(bvid)).success, false);
    assert.equal(app.calls.length, 0);
  }
});

test('HTTP 或业务失败不能伪装成同步成功', async () => {
  for (const options of [{ syncCode: 113000 }, { syncOk: false }, { syncData: false }]) {
    const app = background({ lookup: {data: marked}, ...options });
    assert.equal((await app.sync()).success, false);
  }
});

test('重新读取服务端记录，删除标记后不继续同步', async () => {
  const lookup = {data: marked};
  const app = background({ lookup });
  assert.equal((await app.sync()).data.skipped, false);
  lookup.data = null;
  const before = app.calls.length;
  assert.equal((await app.sync()).data.skipped, true);
  assert.equal(app.calls.length - before, 1);
});

test('每次请求重读服务地址，精确查询和同步仍使用进入链路时读取的授权头及原有传输策略', async () => {
  const reads = [];
  const hosts = ['lookup.test', 'sync.test'];
  const app = background({
    lookup: {data: marked},
    storageGet: async keys => {
      reads.push(Array.from(keys));
      if (reads.length === 1) return {authToken: 'initial-token'};
      return {authToken: 'changed-token', apiBaseUrl: `https://${hosts[reads.length - 2]}/api`};
    }
  });
  assert.equal((await app.sync()).success, true);
  assert.deepEqual(reads, [['authToken'], ...hosts.map(() => ['authToken', 'apiBaseUrl'])]);
  const calls = app.calls.filter(call => !call.url.startsWith('https://api.bilibili.com/'));
  assert.deepEqual(calls.map(call => new URL(call.url).hostname), hosts);
  for (const {options} of calls) {
    assert.equal(options.headers.Authorization, 'initial-token');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'follow');
    assert.equal(options.signal, undefined);
  }
});

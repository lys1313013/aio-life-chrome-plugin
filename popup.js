/** AIO Life - Popup */
document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const statusDot = document.getElementById('status-dot');
  const tagItems = [...document.querySelectorAll('.tag-item')];
  const authInput = document.getElementById('auth-token');
  const authState = document.getElementById('auth-state');
  const saveAuthBtn = document.getElementById('save-auth');
  const authSettings = document.getElementById('auth-settings');
  const toggleAuth = document.getElementById('toggle-auth');
  let tab;
  let validVideo = false;
  let syncing = false;
  const apiInput = document.getElementById('api-base');
  const captureButton = document.getElementById('capture-page');
  async function call(message) { const result = await chrome.runtime.sendMessage(message); if (!result?.success) throw new Error(result?.error || '扩展后台未响应'); return result.data; }

  function setStatus(message, state = 'idle') {
    statusEl.textContent = message;
    statusDot.dataset.state = state;
  }

  function updateAuthState(token) {
    authState.textContent = token ? '已配置' : '未配置';
    authState.classList.toggle('is-configured', Boolean(token));
  }

  document.getElementById('clear-auth').addEventListener('click', async () => {
    try { const result = await call({type: 'CAPTURE_CONFIG_SET', base: apiInput.value.trim(), clearToken: true}); updateAuthState(result.configured); authInput.value = ''; setStatus('已清除 Token', 'success'); } catch (error) { setStatus(error.message, 'error'); }
  });

  const autoToggle = document.getElementById('douban-auto-toggle');
  const autoState = document.getElementById('douban-auto-state');
  try { const settings = await call({type: 'DOUBAN_AUTO_SETTINGS_GET'}); autoToggle.checked = settings.enabled; autoState.textContent = ''; }
  catch (error) { autoState.textContent = error.message; }
  autoToggle.addEventListener('change', async () => {
    const requested = autoToggle.checked; autoToggle.disabled = true;
    try {
      if (requested && !await chrome.permissions.request({origins: ['https://movie.douban.com/*']})) throw new Error('未授予豆瓣站点权限，自动同步保持关闭');
      const settings = await call({type: 'DOUBAN_AUTO_SETTINGS_SET', enabled: requested});
      autoToggle.checked = settings.enabled; autoState.textContent = '';
    } catch (error) { autoToggle.checked = !requested; autoState.textContent = error.message; }
    finally { autoToggle.disabled = false; }
  });

  toggleAuth.addEventListener('click', () => {
    const show = authInput.type === 'password';
    authInput.type = show ? 'text' : 'password';
    toggleAuth.setAttribute('aria-label', show ? '隐藏 Token' : '显示 Token');
    toggleAuth.setAttribute('aria-pressed', String(show));
  });

  document.getElementById('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    saveAuthBtn.disabled = true;
    saveAuthBtn.textContent = '保存中…';
    try {
      const token = authInput.value.trim();
      const base = AioConfig.apiBase(apiInput.value.trim());
      const origin = new URL(base).origin + '/*';
      const permitted = await chrome.permissions.request({origins: [origin]});
      if (!permitted) throw new Error('需要允许访问你配置的 API 服务地址');
      const result = await call({type: 'CAPTURE_CONFIG_SET', base, token});
      authInput.value = '';
      updateAuthState(result.configured);
      setStatus('配置已保存', 'success');
    } catch (error) {
      setStatus(error.message || '保存失败，请重试', 'error');
    } finally {
      saveAuthBtn.disabled = false;
      saveAuthBtn.textContent = '保存配置';
    }
  });

  try {
    const result = await call({type: 'CAPTURE_CONFIG_GET'});
    apiInput.value = result.base;
    updateAuthState(result.configured);
    authSettings.open = !result.configured;
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ? new URL(tab.url) : null;
    const identity = AioCapture.identify(tab?.url);
    captureButton.disabled = !identity;
    if (identity) {
      captureButton.textContent = identity.kind === 'douban' ? '加入阅读／观影' : '录入设备／衣柜';
      document.getElementById('platform-badge').textContent = identity.kind === 'douban' ? '豆瓣' : identity.platform === 'jd' ? '京东' : '淘宝';
    }
    validVideo = Boolean(url && url.protocol === 'https:' && url.hostname === 'www.bilibili.com' && extractBvid(url.pathname));
    if (validVideo) {
      document.getElementById('video-label').textContent = '当前视频';
      const title = tab.title?.replace(/_哔哩哔哩_bilibili$/, '').trim() || '哔哩哔哩视频';
      document.getElementById('video-title').textContent = title;
      document.getElementById('video-title').title = title;
      document.getElementById('video-meta').textContent = `${extractBvid(tab.url)} · 第 ${extractPart(tab.url)} P`;
      tagItems.forEach(item => item.disabled = false);
      document.querySelector('.capture-section').hidden = true;
      setStatus(result.configured ? '' : '请先配置 Token');
    } else {
      document.getElementById('video-title').textContent = identity ? (tab.title || '当前页面') : '打开需要收藏或录入的页面';
      document.getElementById('video-meta').textContent = identity ? url.hostname : '支持豆瓣、京东／淘宝订单、B 站视频';
      document.querySelector('.tag-section').hidden = true;
      document.querySelector('.capture-section').hidden = !identity;
      setStatus(result.configured ? '' : '请先配置 Token');
    }
  } catch {
    document.getElementById('video-title').textContent = '暂时无法读取页面';
    document.getElementById('video-meta').textContent = '请关闭插件面板后重新打开';
    setStatus('初始化失败，请重新打开插件', 'error');
  }

  captureButton.addEventListener('click', async () => {
    captureButton.disabled = true;
    setStatus('正在读取页面…', 'loading');
    try {
      AioCapture.assertHandoffProtocol(await call({type: 'CAPTURE_CONFIG_GET'}));
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['capture/core.js', 'capture/adapters/common.js', 'capture/adapters/douban.js', 'capture/adapters/jd.js', 'capture/adapters/taobao.js', 'capture/extract.js']});
      const results = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => extractAioCapture()});
      const capture = results[0]?.result;
      if (!capture) throw new Error('页面未返回内容，请等待订单加载完后重试');
      await call({type: 'CAPTURE_OPEN', capture});
      window.close();
    } catch (error) { setStatus(error.message || '采集失败，请刷新页面后重试', 'error'); captureButton.disabled = false; }
  });

  tagItems.forEach(item => {
    item.addEventListener('click', async () => {
      if (!validVideo || syncing) return;
      syncing = true;
      tagItems.forEach(button => button.disabled = true);
      item.classList.add('is-loading');
      item.setAttribute('aria-busy', 'true');
      const tag = item.dataset.tag;
      setStatus(`正在同步「${tag}」…`, 'loading');
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'SYNC_TAG',
          data: { bvid: extractBvid(tab.url), tag, p: extractPart(tab.url), timestamp: Date.now() }
        });
        if (!response?.success || (response.data?.code != null && response.data.code !== 0)) {
          throw new Error(response?.error || response?.data?.message || '同步失败，请重试');
        }
        item.classList.add('is-selected');
        setStatus(`已同步为「${tag}」`, 'success');
        setTimeout(() => window.close(), 1000);
      } catch (error) {
        setStatus(error.message || '同步失败，请重试', 'error');
        syncing = false;
        tagItems.forEach(button => button.disabled = false);
      } finally {
        item.classList.remove('is-loading');
        item.removeAttribute('aria-busy');
      }
    });
  });
});

function extractBvid(url) {
  const match = url.match(/\/video\/(BV[a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function extractPart(url) {
  return new URL(url).searchParams.get('p') || '1';
}

(function (root) {
  'use strict';
  function start({document: doc, url, transport, requireTrusted = true}) {
    const identity = root.AioDoubanNative.movieIdentity(url);
    if (!identity) return null;
    let detector = null, enabled = false, scope, notice, timer, intentReady = Promise.resolve();
    const request = async message => {
      const response = await transport({...message, url: identity.url, scope});
      if (!response?.success) throw new Error(response?.error || 'AIO Life 扩展后台未响应');
      return response.data;
    };
    function show(text, retry = false, clear = false) {
      if (!notice?.isConnected) {
        notice = doc.createElement('div'); notice.id = 'aio-douban-native-status'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
        Object.assign(notice.style, {position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647', maxWidth: '360px', background: '#fff', color: '#303238', border: '1px solid #e7e8eb', borderRadius: '12px', padding: '14px 16px', boxShadow: '0 4px 24px #0002', font: '13px/1.7 system-ui,sans-serif'});
        doc.documentElement.append(notice);
      }
      notice.replaceChildren(doc.createTextNode(text));
      if (timer) clearTimeout(timer);
      if (retry) {
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = '核实后使用原请求重试';
        Object.assign(button.style, {display: 'block', marginTop: '8px', border: '1px solid #303238', background: '#f5f6f7', color: '#303238', borderRadius: '6px', padding: '5px 8px', cursor: 'pointer'});
        button.addEventListener('click', async () => { button.disabled = true; try { render(await request({type: 'DOUBAN_AUTO_RETRY'})); } catch (error) { show(error.message, true); } }); notice.append(button);
      }
      if (clear) {
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = '核实后清除待处理同步';
        Object.assign(button.style, {display: 'block', marginTop: '8px', border: '1px solid #e7e8eb', background: '#fff', color: '#74777f', borderRadius: '6px', padding: '5px 8px', cursor: 'pointer'});
        button.addEventListener('click', async () => {
          if (!doc.defaultView.confirm('请先核对 AIO Life。此操作仅清除当前条目的本地待处理同步，不会新增或删除业务记录；之后需要重新在豆瓣保存或取消标记。')) return;
          button.disabled = true; try { detector?.cancel(); render(await request({type: 'DOUBAN_AUTO_CLEAR'})); } catch (error) { show(error.message, false, true); }
        }); notice.append(button);
      }
      if (!retry && !clear && (text.includes('已同步') || text.includes('已从') || text.includes('无需移除'))) timer = setTimeout(() => notice?.remove(), 8000);
    }
    function render(result) {
      if (result.state === 'sending') { show(result.status === 'removed' ? '正在同步豆瓣标记移除…' : '豆瓣标记已保存，正在同步 AIO Life…'); return; }
      if (result.state === 'success') {
        const warnings = result.result?.warnings?.join('；');
        const label = result.status === 'removed' ? result.result?.operation === 'absent' ? 'AIO Life 中没有对应观影记录，无需移除。' : '已从 AIO Life 移除对应观影记录。' : `已同步到 AIO Life · ${result.status === 'completed' ? '看过' : '想看'}`;
        show(warnings ? `${label} ${warnings}` : label); return;
      }
      if (['uncertain', 'failed', 'blocked', 'sending'].includes(result.state) || result.pending) show(result.message || '上次同步结果待确认，请先到 AIO Life 核实。', result.state !== 'expired', true);
      else if (result.state === 'expired' || result.state === 'paused' || result.state === 'cleared') show(result.message);
    }
    async function confirmed(event) {
      if (!enabled) return;
      try {
        if (event.status === 'removed') await intentReady;
        const metadata = event.status === 'removed' ? undefined : root.AioAdapters?.douban(doc, identity.url)?.draft?.metadata;
        show(event.status === 'removed' ? '豆瓣标记已移除，正在同步 AIO Life…' : '豆瓣标记已保存，正在同步 AIO Life…');
        render(await request({type: 'DOUBAN_AUTO_CONFIRMED', ...event, metadata}));
      } catch (error) { show(error.message + '。豆瓣原操作不受影响。', true); }
    }
    function install() {
      detector?.stop();
      detector = new root.AioDoubanNative.SavedInterestDetector({document: doc, url: identity.url, requireTrusted, onConfirmed: confirmed, onUnconfirmed: text => show(text), onIntent: event => {
        intentReady = request({type: 'DOUBAN_AUTO_REMOVE_ARM', ...event});
        intentReady.catch(error => show('无法准备移除同步：' + error.message));
      }});
    }
    async function refresh() {
      try {
        const settings = await request({type: 'DOUBAN_AUTO_PAGE_GET'}); enabled = settings.enabled; scope = settings.scope;
        if (!enabled) { detector?.stop(); detector = null; return; }
        install();
        if (settings.removeIntent) { intentReady = Promise.resolve(); detector.resumeRemoval(settings.removeIntent.eventId, settings.removeIntent.expiresAt); }
        render(settings);
      } catch (error) { show(error.message); }
    }
    function receive(message) {
      if (message.type === 'DOUBAN_AUTO_TOGGLE') { enabled = Boolean(message.enabled); if (enabled) refresh(); else { detector?.stop(); detector = null; notice?.remove(); } }
      if (message.type === 'DOUBAN_AUTO_RESULT' && root.AioDoubanNative.movieIdentity(message.url)?.id === identity.id) render(message);
    }
    refresh();
    return {refresh, receive, stop: () => { enabled = false; detector?.stop(); notice?.remove(); if (timer) clearTimeout(timer); }};
  }
  root.AioDoubanAuto = {start};
  if (typeof module !== 'undefined') module.exports = root.AioDoubanAuto;
  if (typeof document !== 'undefined' && root.chrome?.runtime && root.AioDoubanNative.movieIdentity(location.href)) {
    if (root.AioDoubanAutoInstance) { root.AioDoubanAutoInstance.refresh(); return; }
    root.AioDoubanAutoInstance = start({document, url: location.href, transport: message => chrome.runtime.sendMessage(message)});
    chrome.runtime.onMessage.addListener((message, sender) => { if (sender.id === chrome.runtime.id) root.AioDoubanAutoInstance.receive(message); });
  }
})(globalThis);

/**
 * aiolife for Chrome - Popup Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const tagItems = document.querySelectorAll('.tag-item');
  const authInput = document.getElementById('auth-token');
  const saveAuthBtn = document.getElementById('save-auth');

  // 回显已保存的 Token
  chrome.storage.local.get(['authToken'], (result) => {
    if (result.authToken) {
      authInput.value = result.authToken;
    }
  });

  // 保存 Token 逻辑
  saveAuthBtn.addEventListener('click', () => {
    const token = authInput.value.trim();
    chrome.storage.local.set({ authToken: token }, () => {
      statusEl.textContent = 'Token 已保存';
      setTimeout(() => statusEl.textContent = '已就绪', 1500);
    });
  });

  // 获取当前活跃标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url || !tab.url.includes('bilibili.com/video/BV')) {
    statusEl.textContent = '当前不是B站视频页';
    tagItems.forEach(item => item.style.pointerEvents = 'none');
    return;
  }

  statusEl.textContent = '已就绪';

  // 绑定点击事件
  tagItems.forEach(item => {
    item.addEventListener('click', async () => {
      const tag = item.getAttribute('data-tag');
      const bvid = extractBvid(tab.url);
      const p = extractPart(tab.url);

      statusEl.textContent = '正在同步...';

      // 发送给 Background
      chrome.runtime.sendMessage({
        type: 'SYNC_TAG',
        data: {
          bvid: bvid,
          tag: tag,
          p: p,
          timestamp: Date.now()
        }
      }, (response) => {
        if (response && response.success) {
          statusEl.textContent = `成功打标: ${tag}`;
          setTimeout(() => window.close(), 1000); // 1秒后自动关闭
        } else {
          statusEl.textContent = '同步失败';
          console.error(response);
        }
      });
    });
  });
});

function extractBvid(url) {
  const match = url.match(/\/video\/(BV[a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function extractPart(url) {
  const urlObj = new URL(url);
  return urlObj.searchParams.get('p') || '1';
}

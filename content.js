/**
 * aiolife for Chrome - Bilibili Video Progress & Tagging Content Script
 */

(function() {
  console.log('aiolife: Content script loaded');

  // 提取 BVID
  function getBvid() {
    const match = window.location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }

  // 提取分 P (第几集)
  function getPartNumber() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('p') || '1';
  }

  // 注入 UI 按钮
  function injectTagButton() {
    // 查找 B 站的“更多”菜单列表
    // B 站的更多菜单通常在点击三点图标后动态生成，或者隐藏在 .more-ops-list 中
    const moreOpsList = document.querySelector('.more-ops-list');
    
    if (!moreOpsList) {
      // 如果还没找到更多菜单，可能是还没加载或者用户还没点开，我们持续观察
      setTimeout(injectTagButton, 1000);
      return;
    }

    if (document.getElementById('aiolife-more-item')) return;

    // 创建一个新的菜单项，模仿 B 站原生的样式
    const menuItem = document.createElement('li');
    menuItem.id = 'aiolife-more-item';
    menuItem.className = 'more-ops-item'; // 使用 B 站原生的类名
    menuItem.innerHTML = `
      <div class="aiolife-more-container">
        <button type="button" class="aiolife-label">视频打标</button>
        <div class="aiolife-sub-menu">
          <div class="aiolife-menu-heading">AIO Life · 标记视频</div>
          <button type="button" class="aiolife-sub-item" data-tag="待看">待看</button>
          <button type="button" class="aiolife-sub-item" data-tag="已看">已看</button>
          <button type="button" class="aiolife-sub-item" data-tag="学习中">学习中</button>
          <button type="button" class="aiolife-sub-item" data-tag="暂停">暂停</button>
        </div>
      </div>
    `;

    moreOpsList.appendChild(menuItem);

    // 绑定子菜单事件
    menuItem.querySelectorAll('.aiolife-sub-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const tag = e.currentTarget.getAttribute('data-tag');
        handleTagging(tag);
        // 点击后隐藏 B 站的更多菜单（可选）
        moreOpsList.style.display = 'none';
      });
    });
  }

  // 显示 Toast 提示
  let toastTimer = null;
  function showToast(message, duration = 3000, state = 'success') {
    let toast = document.querySelector('.aiolife-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'aiolife-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    
    toast.dataset.state = state;
    const icon = document.createElement('span');
    icon.className = 'aiolife-toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = state === 'error' ? '!' : state === 'loading' ? '·' : '✓';
    const text = document.createElement('span');
    text.textContent = message;
    toast.replaceChildren(icon, text);
    
    // 清除之前的定时器
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    
    // 强制重绘
    toast.offsetHeight;
    
    toast.classList.add('show');
    
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      toastTimer = null;
    }, duration);
  }

  // 处理打标逻辑
  let tagging = false;
  async function handleTagging(tag) {
    if (tagging) return;
    tagging = true;
    showToast(`正在同步「${tag}」…`, 30000, 'loading');
    const bvid = getBvid();
    const p = getPartNumber();
    const progress = getProgress();
    console.log(`aiolife: Tagging ${bvid} (P${p}) as ${tag} at ${progress.currentTime}s`);

    // 发送给 Background 处理 API 调用
    chrome.runtime.sendMessage({
      type: 'SYNC_TAG',
      data: {
        bvid: bvid,
        tag: tag,
        p: p,
        currentTime: progress.currentTime,
        timestamp: Date.now()
      }
    }, (response) => {
      tagging = false;
      const runtimeError = chrome.runtime.lastError;
      if (!runtimeError && response?.success && (response.data?.code == null || response.data.code === 0)) {
        const totalProgress = response.data?.totalProgress ?? progress.percentage;
        showToast(`已标记为「${tag}」 · 进度 ${totalProgress}%`);
      } else {
        showToast(response?.error || response?.data?.message || '同步失败，请重试', 4000, 'error');
        console.error('aiolife: Tagging failed', response);
      }
    });
  }

  // 监听 URL 变化（B站是单页应用，切换视频不会刷新页面）
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      document.querySelector('.aiolife-toast')?.classList.remove('show');
      console.log('aiolife: URL changed, re-initializing...');
      init();
    }
  }).observe(document, {subtree: true, childList: true});

  // 获取当前播放进度
  function getProgress() {
    const video = document.querySelector('video');
    if (video && video.duration) {
      return {
        percentage: Math.round((video.currentTime / video.duration) * 100),
        currentTime: Math.floor(video.currentTime),
        duration: Math.floor(video.duration)
      };
    }
    return { percentage: 0, currentTime: 0, duration: 0 };
  }

  // 进度同步逻辑
  function initProgressSync() {
    const bvid = getBvid();
    const p = getPartNumber();
    const progress = getProgress();
    
    const pageUrl = location.href;
    // 后台先确认视频已标记；未标记的视频静默跳过。
    chrome.runtime.sendMessage({
      type: 'SYNC_PROGRESS',
      data: {
        bvid: bvid,
        p: p,
        currentTime: progress.currentTime,
        timestamp: Date.now()
      }
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || location.href !== pageUrl) return;
      if (response?.success && response.data?.code === 0 && response.data.skipped === false) {
        const totalProgress = response.data?.totalProgress ?? progress.percentage;
        showToast(`观看进度已自动同步，当前进度 ${totalProgress}%`);
      }
    });
  }

  function init() {
    if (window.location.href.includes('/video/BV')) {
      initProgressSync();
      injectTagButton();
    }
  }

  // 页面加载完成后初始化
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

})();

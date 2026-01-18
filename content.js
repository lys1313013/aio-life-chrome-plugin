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
        <span class="aiolife-label">视频打标</span>
        <div class="aiolife-sub-menu">
          <div class="aiolife-sub-item" data-tag="待看">待看</div>
          <div class="aiolife-sub-item" data-tag="已看">已看</div>
          <div class="aiolife-sub-item" data-tag="学习中">学习中</div>
          <div class="aiolife-sub-item" data-tag="收藏">收藏</div>
        </div>
      </div>
    `;

    moreOpsList.appendChild(menuItem);

    // 绑定子菜单事件
    menuItem.querySelectorAll('.aiolife-sub-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const tag = e.target.getAttribute('data-tag');
        handleTagging(tag);
        // 点击后隐藏 B 站的更多菜单（可选）
        moreOpsList.style.display = 'none';
      });
    });
  }

  // 显示 Toast 提示
  let toastTimer = null;
  function showToast(message, duration = 3000) {
    let toast = document.querySelector('.aiolife-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'aiolife-toast';
      document.body.appendChild(toast);
    }
    
    toast.innerHTML = `<span class="aiolife-toast-icon">✓</span> ${message}`;
    
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
  async function handleTagging(tag) {
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
      if (response && response.success) {
        const totalProgress = response.data?.totalProgress ?? progress.percentage;
        showToast(`打标成功: ${tag} (${totalProgress}%)`);
      } else {
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
    
    // 进入时同步：从后端获取进度
    chrome.runtime.sendMessage({
      type: 'GET_PROGRESS',
      bvid: bvid
    }, (response) => {
      if (response && response.data) {
        console.log('aiolife: Remote progress found', response.data);
        // 这里可以做跳转逻辑，比如如果 response.data.p != p，提示用户跳转
      }
    });

    // 监听分 P 切换：B站切换分 P 通常会触发 URL 变化，MutationObserver 已经处理了重新 init
    // 我们可以每隔一段时间自动同步一次当前 P 
    chrome.runtime.sendMessage({
      type: 'SYNC_PROGRESS',
      data: {
        bvid: bvid,
        p: p,
        currentTime: progress.currentTime,
        timestamp: Date.now()
      }
    }, (response) => {
      if (response && response.success) {
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

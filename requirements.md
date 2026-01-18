# aiolife for Chrome 需求文档

## 1. 项目概述
开发一个 aiolife 官方浏览器插件，专门针对 Bilibili (B站) 视频播放页。通过识别视频的 `bvid`，实现手动打标分类和自动同步观看进度的功能，并将数据持久化到 aiolife 远程服务器。

## 2. 核心功能需求

### 2.1 视频识别与初始化
- **触发条件**：当用户进入 `https://www.bilibili.com/video/BVxxxxxx/` 路径的页面时。
- **唯一标识**：从 URL 路径中提取 `bvid`，从查询参数中提取分 P (`p`)。
- **元数据获取**：插件后台会通过 B 站官方 API (`/x/web-interface/view`) 获取视频详细信息（标题、封面、总时长、分 P 列表等）。

### 2.2 打标功能 (Tagging)
- **多入口交互**：
  1. **Popup 弹窗**：点击插件图标，在弹出窗口中选择预设标签（待看、已看、学习中、收藏）。
  2. **页面注入 (实验性)**：在 B 站视频页面的“更多”菜单 (`.more-ops-list`) 中注入打标功能。
- **同步逻辑**：选择标签后，触发 **“同步打标接口”**，将视频完整信息及标签状态同步至后端。

### 2.3 观看进度同步 (Progress Sync)
- **自动同步**：
  1. **进入同步**：页面加载时自动触发。
  2. **切换同步**：当用户切换分 P (URL 变化) 时自动触发。
- **数据计算**：后台会自动计算 `watchedDuration`（当前集之前的总时长累计）。
- **同步载体**：发送 `bvid`、`currentEpisode` (当前 P)、`watchedDuration`。

### 2.4 配置管理
- **授权验证**：用户可在 Popup 界面配置 `Authorization` Token，用于 API 请求鉴权。
- **持久化**：Token 存储在 `chrome.storage.local` 中。

## 3. 技术规范

### 3.1 插件架构
- **Manifest V3**：采用最新的插件标准。
- **Content Scripts**：
  - 监听 URL 变化（MutationObserver）。
  - 提取页面 `bvid` 和 `p` 参数。
  - 负责 DOM 注入和 Toast 消息显示。
- **Background Service Worker**：
  - 中转 API 请求，处理跨域。
  - 维护视频信息缓存 (`videoInfoCache`)。
  - 计算观看时长逻辑。

### 3.2 API 接口定义

**API 基础路径**: `https://aiolife.top/api/bilibili-video`

#### A. 同步打标信息 (Tag Video)
- **Method**: `POST /tagVideo`
- **Headers**: `Authorization: {token}`
- **Payload**:
  ```json
  {
    "bvid": "BVxxxxxx",
    "title": "视频标题",
    "url": "https://bilibili.com/video/BVxxxxxx?p=1",
    "cover": "封面图URL",
    "duration": 1234,
    "episodes": 10,
    "currentEpisode": 1,
    "progress": 0,
    "status": 2,
    "ownerName": "UP主名称",
    "watchedDuration": 0
  }
  ```

#### B. 同步进度信息 (Sync Progress)
- **Method**: `POST /syncProgress`
- **Payload**:
  ```json
  {
    "bvid": "BVxxxxxx",
    "currentEpisode": 2,
    "watchedDuration": 600
  }
  ```

## 4. UI/UX 设计
- **Toast 提示**：同步成功时在页面顶部显示简洁的 Toast 提示。
- **Popup 界面**：提供快速打标按钮和 Token 配置项。

## 5. 待完善事项
1. **进度获取接口**：目前 `GET_PROGRESS` 逻辑暂未完整实现，仅返回默认值。
2. **注入稳定性**：B 站页面 DOM 结构动态性强，注入按钮的逻辑需进一步增强鲁棒性。
3. **播放器状态监听**：目前仅监听分 P 切换，未来可考虑监听播放器 `timeupdate` 实现更细粒度的进度同步。

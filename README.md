<h2 align="center">🎵 Lyra Sphere</h2>

<p align="center">第三方音乐播放器 · 沉浸式歌词 · 桌面歌词 · 音乐下载 · 最高音质</p>

---

## 本项目是什么

Lyra Sphere 是 **[AlgerMusicPlayer](https://github.com/algerkong/AlgerMusicPlayer)** 的定制版本，
在上游 **5.1.0** 的基础上改名，并修掉了使用中遇到的一批问题。上游由
[Alger](https://github.com/algerkong) 开发，以 MIT 许可发布，本仓库沿用同一许可，
原始版权归 Alger 所有（见 [LICENSE](./LICENSE)）。

想了解软件本身的完整功能、交流或反馈上游问题，请访问
[上游仓库](https://github.com/algerkong/AlgerMusicPlayer)。

## 本版本的优化点

### 桌面端（Windows）

- **任务栏与托盘悬停显示当前歌曲** —— 悬停即可看到「歌曲 - 歌手」，不必切回窗口。
  各音源歌手字段不统一（网易云在 `ar`、其他在 `artists` / `song.artists`），
  已按优先级统一取值，默认音源不再只显示歌名。
- **图标内容占比调整** —— 原图标四周留白偏多，任务栏里比邻近图标显得小；现已放大内容占比。

### 移动端 / Android

- **接入系统媒体会话与通知栏控制** —— 支持锁屏/通知栏媒体卡片与耳机线控。
- **修复整条音源解析链** —— 此前 Android 上会出现全部音源解析失败（293/293 全挂），现已修复。
- **返回键先交给前端处理** —— 不再在任意界面直接退出应用。
- **开放音源接口配置** —— 手机端也能自行配置音源接口。
- **布局修复** —— 收藏/历史页在手机上只剩播放记录；首页 Hero 卡片撑破栅格导致整页可左右晃动。

### 通用

- **修复本地缓存歌曲拖动进度后反复自动重播** —— 自定义 `local://` 协议不是可随机读取的数据源，
  跳转进度会触发底层读取错误并导致无限「解析 → 播放 → 过期 → 解析」循环；播放时改用 `file://`，
  并为自动恢复加上重试上限。
- **收藏/历史页「播放全部」不再等待分页加载完成** —— 长列表可以立刻开始播放。
- **移除捐赠入口。**

## 主要功能

- 音乐推荐、每日推荐、排行榜；歌单、MV、专辑
- 搜索音乐 / MV / 专辑 / 歌单 / bilibili
- 音乐资源解析，可单独为某首歌选择音源
- 账号登录与同步、播放历史、歌曲收藏
- 沉浸式歌词（点击左下角封面进入）、独立桌面歌词窗口
- EQ 均衡器、倍速播放、定时播放、远程控制播放
- 明暗主题切换、迷你模式、状态栏控制、多语言、自定义快捷键
- 高品质音乐与音乐文件下载
- 全平台：Desktop / Web / Mobile Web / Android

## 项目启动

```bash
npm install
npm run dev
```

## 打包

```bash
npm run build:win      # Windows（zip）
npm run build:mac      # macOS
npm run build:linux    # Linux
npm run build:android  # Android
```

## 文档

- [开发文档](./DEV.md)
- [自定义音源接口](./docs/custom-api-readme.md)
- [构建与打包指南](./docs/build-and-package-guide.md)
- [Android 构建指南](./docs/android-build-guide.md)

## 声明

本软件仅用于学习交流，禁止用于商业用途，否则后果自负。
请大家多多支持正版音乐。

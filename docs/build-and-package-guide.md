# AlgerMusicPlayer 构建与打包记录

> 记录日期：2026-09-17
> 适用版本：AlgerMusicPlayer 5.1.0
> 记录人：Claude Code

本文档记录在本机从零构建、运行并打包该项目的完整过程，包含遇到的两次失败及其原因和解决办法，供后续复现或换机部署时参考。

---

## 一、环境信息

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 11 Home China 10.0.26200 |
| CPU | Intel Core Ultra 7 255HX（x64 / AMD64） |
| Shell | Git Bash (POSIX sh) |
| Node.js | v26.3.1 |
| npm | 11.16.0 |
| Electron | 40.10.6 |
| electron-vite | 5.0.0 |
| Vite | 6.4.3 |
| electron-builder | 26.15.3 |
| 项目声明要求 | Node 18+（见 `DEV.md`） |

说明：项目脚本 `lint:i18n` 使用了 `bun`，本机未安装。该脚本仅用于国际化文案校验，**不影响构建、运行和打包**。

---

## 二、操作时间线

| 时间 | 操作 | 结果 |
| --- | --- | --- |
| 15:26 | 检查项目结构、确认 `node_modules` 缺失 | — |
| 15:30 | `npm install` | ❌ 失败，退出码 1 |
| 15:41 | 写入 `.npmrc` 配置国内镜像 | ✅ |
| 15:41 | `npm install`（重试） | ✅ 成功，732 个包 |
| 15:47 | `npm run dev` | ✅ 编译并启动成功 |
| 15:51 | `npm run build` + `electron-builder --win --x64` | ❌ 打包阶段失败，退出码 3 |
| 15:56 | `electron-builder --win zip --x64` | ✅ 成功产出 ZIP |
| 16:00 | 解压 ZIP 实机验证运行 | ✅ 通过 |
| 16:18 | 清理 `dist/` 残留产物 | ✅ |

---

## 三、问题一：依赖安装失败（Electron 二进制下载）

### 3.1 报错输出

首次执行 `npm install` 报错：

```text
npm error path ...\node_modules\electron
npm error command C:\Windows\system32\cmd.exe /d /s /c node install.js
npm error TypeError: fetch failed
```

随后 npm 触发回滚，`node_modules` 被清空（实测当时已解包 732 个目录，全部被删除）。

### 3.2 原因分析

Electron 的 `postinstall` 脚本需要从 **github.com** 下载约 137 MB 的运行时二进制。经实测：

- `https://github.com` → 连接超时，**不可达**
- `https://registry.npmjs.org/` → 正常，延迟约 2.5 s
- `https://npmmirror.com/mirrors/electron/` → 正常，返回 302 并成功指向 CDN 上的 Electron 压缩包

即 **npm 源本身通畅，唯独 GitHub Releases 被阻断**，导致 Electron 二进制拉取失败。

### 3.3 解决办法

在项目根目录新建 `.npmrc`：

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

第一条解决 Electron 运行时下载；第二条为 `postinstall` 中的 `electron-builder install-app-deps` 准备，避免打包阶段再去 GitHub 拉 `winCodeSign`、`nsis` 等工具链时重复踩坑。

之后重新执行 `npm install` 即成功，Electron 二进制经该镜像下载完成（日志：`downloaded label=electron progress=100%`），可确认镜像确实生效。

> 注：npm 11 会对这两个键输出 `Unknown project config` 警告。这是 npm 的提示而非报错，配置仍然生效（已验证 Electron 二进制成功下载）。

---

## 四、问题二：打包失败（NSIS 被本机策略拦截）

### 4.1 报错输出

`npm run build:win`（等价于 `npm run build && electron-builder --win --publish never`）在最后一步失败：

```text
• building  target=nsis file=dist\AlgerMusicPlayer-5.1.0-win-x64.exe archs=x64 oneClick=false perMachine=false
• downloaded  label=nsis-resources-3.4.1.7z progress=100%
AssignProcessToJobObject: (6) 句柄无效
[exited with code 3]
```

### 4.2 关键判断

**失败点在最后一步，而非构建本身。** 日志显示在此之前，三个架构的打包均已成功完成：

- `x64` → `dist/win-unpacked`，Electron 二进制下载 100%，应用签名（signtool）执行完毕
- `ia32` → `dist/win-ia32-unpacked`，同样完成
- `arm64` → `dist/win-arm64-unpacked`，同样完成

即**应用本体已经打好**，只是 NSIS 安装包生成器进程无法启动。`AssignProcessToJobObject: (6)` 是本机安全策略对安装包制作进程的限制所致。

### 4.3 解决办法

改用 electron-builder 的 `zip` 目标，完全绕开 NSIS：

```bash
npm run build
npx electron-builder --win zip --x64 --publish never
```

一次通过。同时只构建 x64（本机架构），相比默认的三架构并行节省约三分之二时间。

---

## 五、交付产物

```
dist/AlgerMusicPlayer-5.1.0-win-x64.zip
```

| 指标 | 值 |
| --- | --- |
| 压缩包大小 | 159,838,620 字节（约 152 MiB） |
| 解压后大小 | 407,066,965 字节（约 388 MiB） |
| 文件数 | 108 个文件 / 16 个目录 |
| 主程序 | `AlgerMusicPlayer.exe`（位于压缩包**根目录**） |

**使用方式**：解压到任意文件夹，双击 `AlgerMusicPlayer.exe` 即可运行。无需安装、不写注册表。用户配置存放于 `%APPDATA%`，因此解压目录之后可以随意移动或改名。

### 验证记录

对交付的 ZIP 做了解压实机验证，非仅检查文件存在：

1. 用 7-Zip 完整解压到临时目录 → 108 个文件全部通过 CRC 校验
2. 直接启动解压出的 `AlgerMusicPlayer.exe`
3. 窗口正常打开，标题为 `AlgerMusicPlayer — algerkong`，尺寸 1200×780
4. 内置音乐服务在 `127.0.0.1:30488` 正常监听
5. 接口探活返回 HTTP 200：`/personalized`、`/search/default`
6. 关闭进程，清理临时目录（389 MB）

---

## 六、复现步骤（完整命令）

```bash
cd /d/XC_workspace/musicDL/AlgerMusicPlayer-5.1.0

# 1. 安装依赖（首次，需先确保 .npmrc 存在）
npm install

# 2. 开发模式运行（含 Vite HMR）
npm run dev

# 3. 打包为可分发的 ZIP
npm run build
npx electron-builder --win zip --x64 --publish never
```

产物位于 `dist/AlgerMusicPlayer-5.1.0-win-x64.zip`。

### 需要其他架构时

```bash
npx electron-builder --win zip --ia32  --publish never   # 32 位
npx electron-builder --win zip --arm64 --publish never   # ARM64
```

---

## 七、注意事项

### 1. 不要使用 `npm run build:win`

该脚本硬编码了 NSIS 目标（`"target": "nsis"`，见 `package.json` 的 `build.win` 字段），在本机会以完全相同的方式失败。打包请使用第六节的 `zip` 目标命令。

同理，`build:mac` / `build:linux` 也分别依赖 dmg / AppImage 等目标，本机策略下未必可用。

### 2. 无代码签名证书

应用未做代码签名，首次运行时 Windows SmartScreen 可能弹出警告，选择「仍要运行」即可。这是所有未签名 Electron 应用的常态，不是打包出错。

### 3. 音频接口依赖

应用内置了网易云音乐 API 服务（`src/main/server.ts`），启动时自动监听 30488 端口（被占用时会自动递增重试，最多 10 次）。**开发模式无需额外部署后端服务。**

如需在开发模式下使用网页端（`npm run dev:web`），则需自行部署 `netease-cloud-music-api` 并配置 `.env.development.local`，详见 `DEV.md`。

### 4. 一个上游代码中的安全问题（非本次改动引入）

开发模式启动时，日志会完整打印一串 B 站的 `SESSDATA` / `bili_jct` cookie。来源是源码中硬编码的 `defaultCookieString` 常量。会话凭证明文落盘到日志文件并不合适，若用于正式分发建议留意。

### 5. 窗口状态被高频写入

开发模式日志显示窗口尺寸/坐标被极其频繁地保存（尺寸在 1200×780 与 1200×781 之间反复抖动）。属上游既有逻辑，不影响功能，但会持续写配置文件。

---

## 八、改动清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `.npmrc` | 新增 | Electron / electron-builder 国内镜像配置 |
| `docs/build-and-package-guide.md` | 新增 | 本文档 |
| `src/renderer/App.vue` | 修改 | 移除免责声明组件的引用（见第九节） |
| `src/renderer/components/common/DisclaimerModal.vue` | **删除** | 原含免责声明 / 捐赠弹窗 / 收款码三个弹窗，全部移除（见第九节） |
| `dist/` | 构建产物 | 见下文 |

### `dist/` 清理记录

初次打包失败在 `dist/` 留下了约 1.5 GB 无用产物，已清理以下 9 项：

- 4 个失败的 NSIS 安装器残壳（无法运行）：
  `AlgerMusicPlayer-5.1.0-win.exe`、`-win-x64.exe`、`-win-ia32.exe`、`-win-arm64.exe`
- 3 个无主载荷（共约 332 MB）：
  `AlgerMusicPlayer-5.1.0-{x64,ia32,arm64}.nsis.7z`
- 2 个多余架构的解包目录（共约 724 MB）：
  `win-arm64-unpacked/`、`win-ia32-unpacked/`

`dist/` 现保留：

| 保留项 | 大小 | 用途 |
| --- | --- | --- |
| `AlgerMusicPlayer-5.1.0-win-x64.zip` | 152 MiB | 交付产物 |
| `win-unpacked/` | 389 MB | 解包目录，重新打 ZIP 时可复用缓存 |
| `builder-debug.yml` | 776 B | electron-builder 调试元数据 |

---

## 九、定制改动：移除开屏弹窗

本应用启动时原本有**连续两个**强制弹窗（先免责声明、后捐赠），现均已移除。改动分两步进行。

### 背景

`src/renderer/components/common/DisclaimerModal.vue` 一个文件里塞了**三个**弹窗：

| 弹窗 | 变量 | 原触发时机 | 处置 |
| --- | --- | --- | --- |
| 免责声明 | `showDisclaimer` | 首次启动 | **移除**（第二步） |
| 捐赠弹窗（支持开发者） | `showDonate` | ① 同意免责声明后 ② 每次版本更新后 | **移除**（第一步） |
| 微信 / 支付宝收款码 | `showQRCode` | 从捐赠弹窗点入 | **移除**（第一步） |

关于捐赠弹窗「每次更新都弹」的机制：它把当前 `package.json` 的 `version` 写入 `localStorage.donation_shown_version`，只要版本号一变就再弹一次，因此每次升级都会看到。

### 第一步：移除捐赠弹窗与收款码弹窗

改动位于 `DisclaimerModal.vue`，删除内容：

- 两个 `<Transition>` 模板块（捐赠弹窗、收款码弹窗）
- 状态变量 `showDonate`、`showQRCode`、`qrcodeType`、`isTransitioning`
- 函数 `shouldShowDonateAfterUpdate`、`openDonateLink`、`closeQRCode`、`handleEnterApp`
- 常量 `DONATION_SHOWN_VERSION_KEY`（`donation_shown_version`）
- 无用导入：`alipay.png`、`wechat.png`、`package.json`（仅用于取版本号）
- 对应的 `.donate-modal-*`、`.qrcode-modal-*` 样式

同时调整了 `handleAgree`：原逻辑是先关闭免责声明、延迟 300ms 再打开捐赠弹窗，并由捐赠弹窗的 `handleEnterApp` 写入「已同意」标记。改为 `handleAgree` 直接写入 `disclaimer_agreed_timestamp` 并关闭弹窗。

### 第二步：移除免责声明

免责声明整体删除，涉及两个文件：

**删除** `src/renderer/components/common/DisclaimerModal.vue`（此时该文件仅剩免责声明，已无其他用途）

**修改** `src/renderer/App.vue`：

- 移除 `<disclaimer-modal></disclaimer-modal>` 标签
- 移除 `import DisclaimerModal from '@/components/common/DisclaimerModal.vue'`

删除的是整个组件而非仅隐藏，因此不存在残留死代码。应用现在启动后**直接进入主界面，无任何弹窗**。

### 未改动的部分

捐赠功能本身**并未移除**，仅去掉了开屏强制弹窗。以下入口保持原样：

- 搜索栏的「请我喝咖啡」按钮（`Coffee.vue`）
- 设置页的捐赠者名单（`DonationList.vue` / `DonationTab.vue`）
- 流量警告抽屉中的收款码（`TrafficWarningDrawer.vue`）

`src/i18n/lang/*/comp.ts` 中的 `comp.donate.*` 与 `comp.disclaimer.*` 文案键已无人引用，但**有意保留**：删改需同步 5 个语言文件且收益很低，留着不影响构建与运行。

`localStorage` 中的 `disclaimer_agreed_timestamp`、`donation_shown_version` 两个旧键也不再被读写，属无害残留。

### 验证

| 检查项 | 结果 |
| --- | --- |
| `eslint`（改动文件） | 通过，退出码 0 |
| `prettier --check` | 通过 |
| `vue-tsc` 全量类型检查 | 无错误 |
| `npm run build` | 成功 |
| 构建产物中搜索 `disclaimer-modal` / `donate-modal` / `qrcode-modal` / `comp.disclaimer` / `comp.donate` | 均为 **0 次** |
| 打包后 `app.asar` 内搜索上述关键字 | 均为 **0 次** |
| 实机启动 | 窗口正常、无报错、接口调用全部 `[OK]` |

### 还原方式

备份位于 `%TEMP%\alger-backup\`：

| 备份文件 | 对应状态 |
| --- | --- |
| `DisclaimerModal.vue.orig` | 最原始版本（免责声明 + 捐赠弹窗 + 收款码俱全） |
| `DisclaimerModal.vue.pre-disclaimer-removal` | 第一步完成后（仅剩免责声明） |
| `App.vue.orig` | 第二步之前的 `App.vue` |

如需还原免责声明：将 `DisclaimerModal.vue.pre-disclaimer-removal` 复制回 `src/renderer/components/common/DisclaimerModal.vue`，并用 `App.vue.orig` 覆盖 `src/renderer/App.vue` 即可。

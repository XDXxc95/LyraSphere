# AlgerMusicPlayer Android 版重建记录

> 记录日期：2026-09-18
> 适用版本：AlgerMusicPlayer 5.1.0
> 目标：让 Android 版（APK）恢复播放能力

本文档记录 Android 版无法播放音乐的原因、音源调研过程、所采用的方案，以及从零重建 APK 的完整步骤。

---

## 一、问题定位：不是播放器坏了，是后端没了

官方 APK 里把两个服务地址**硬编码**在打包产物中（`assets/public/assets/index-*.js`）：

```js
// 普通接口（歌单、搜索、歌词…）
const baseURL$1 = window.electron
  ? 'http://127.0.0.1:' + setData?.musicApiPort
  : 'http://mc.alger.fun/api';

// 音乐解析接口
const baseURL = 'http://mc.alger.fun/music_proxy';
```

Android WebView 里 `window.electron` 是 `undefined`，所以两个地址都指向 `mc.alger.fun`。

实测该域名的现状：

| 检查项                  | 结果                                                         |
| ----------------------- | ------------------------------------------------------------ |
| DNS 解析                | 正常，`110.42.251.190`                                       |
| ping                    | 通，约 21ms（本机网络无问题）                                |
| 80 端口（APK 用的）     | **TCP 超时，无服务**                                         |
| 443 端口                | 端口开着，但证书 `CN=www.alger.fun` 已于 **2026-07-10 过期** |
| `https://mc.alger.fun/` | 返回一个**下载页**，`/api` 全部 404                          |

即：作者已把在线服务（API + 网页版）整体下线，`music.alger.fun` 也是同一个下载页，官方下载页现在**只提供桌面版**，已不再分发 APK。

所以 APK 不只是"音乐不能播"——它连歌单都加载不出来，因为浏览接口同样失效。

**桌面端不受影响**，因为它是自包含的：

- `src/main/server.ts` 在主进程内用 `netease-cloud-music-api-alger` 起了本地 API 服务，监听 `127.0.0.1:30488`
- 主窗口设置了 `webSecurity: false`（`src/main/modules/window.ts:302`），完全绕过 CORS
- VIP / 无版权歌曲走 `@unblockneteasemusic/server`，该包直接打进安装包，通过 IPC 在本机运行

样样都不依赖外网。

---

## 二、音源调研结果

以下均为直接请求接口实测所得（本机 WebSearch / WebFetch 被网络策略拦截，故未使用搜索引擎）。

| 音源         | 地址                                                | 支持平台             | CORS | 实测                      |
| ------------ | --------------------------------------------------- | -------------------- | ---- | ------------------------- |
| SodaMusic    | `www.tinysignal.fun/soda_music/music_action_v2.php` | 网易 + 酷我/酷狗兜底 | ✗    | **5/5 可播，含 VIP 独家** |
| 公共网易 API | `api-netease.ontus.cn`                              | 网易                 | `*`  | 浏览接口 17/18 通过       |
| GD音乐台     | `music-api.gdstudio.xyz/api.php`                    | netease/kuwo/joox    | `*`  | 热榜 40/40，独家 ✗        |
| Meting       | `api.injahow.cn/meting/`                            | netease/kuwo/tencent | `*`  | 独家需酷我 ID，不通用     |

### 关于 SodaMusic 音源

来自参考包 `薄荷音乐220.apk`（Flutter 应用），其接口常量位于 `lib/arm64-v8a/libapp.so`：

```
music_action_v2.php?action=getAlgerListenUrl&linkMid=
```

该接口接收网易歌曲 ID，在后端完成跨平台匹配（网易取不到时回退到酷我），无需签名鉴权。实测：

| 歌曲                             | 结果                |
| -------------------------------- | ------------------- |
| 周杰伦《晴天》(186016，VIP 独家) | ✓ 10.29MB（酷我源） |
| 周杰伦《晴天》via GD音乐台       | ✗ 返回空            |
| 孙燕姿《我不难过》               | ✓ 12.23MB           |
| 网易热榜 #1                      | ✓ 6.77MB            |

GD音乐台 / Meting 都拿不到周杰伦这类独家版权曲目，SodaMusic 可以——因为它在后端做了跨平台匹配。这一点与桌面端 `@unblockneteasemusic/server` 的能力一致（实测本地引擎同样通过酷我命中该曲）。

### 关于 CORS

SodaMusic 接口**不返回** `Access-Control-Allow-Origin`，WebView 里常规 XHR 会被拦截。Android 工程中已启用 `CapacitorHttp`，请求改走原生 HTTP，绕过 CORS 限制（Flutter 参考包是原生的，本身不受此限制）。

---

## 三、采用的方案

保持"不使用自建后端、只用公开音源"的前提下，改动如下。

| 层                     | 方案                                                      |
| ---------------------- | --------------------------------------------------------- |
| 浏览（歌单/搜索/歌词） | 指向公共网易 API `api-netease.ontus.cn`                   |
| 播放（含 VIP 解锁）    | 预置 SodaMusic 为「自定义API」音源                        |
| 跨域                   | 启用 `CapacitorHttp`                                      |
| 兜底                   | 自定义音源失败时，仍走官方 `/song/url/v1`（免费歌曲可用） |

### 代码改动清单

| 文件                                                                 | 类型 | 说明                                                         |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------ |
| `src/renderer/const/music-source-preset.ts`                          | 新增 | 预置音源定义 + 网易接口兜底地址                              |
| `src/renderer/store/modules/settings.ts`                             | 修改 | 非 Electron 环境下自动注入预置音源                           |
| `src/renderer/utils/request.ts`                                      | 修改 | `VITE_API` 未配置时回退到公共接口                            |
| `src/renderer/api/musicParser.ts`                                    | 修改 | 非 Electron 的解析回退改为先试自定义音源                     |
| `capacitor.config.ts`                                                | 新增 | Capacitor 配置，启用 CapacitorHttp                           |
| `scripts/prepare_android_assets.mjs`                                 | 新增 | 清理 `.gz` 文件（见第七节）                                  |
| `package.json`                                                       | 修改 | 新增 `build:android` 脚本                                    |
| `android/app/src/main/java/com/algermusic/app/InsetsPlugin.java`     | 新增 | 把系统栏真实高度交给前端                                     |
| `android/app/src/main/java/com/algermusic/app/MainActivity.java`     | 修改 | 注册 `InsetsPlugin`                                          |
| `src/renderer/utils/nativeInsets.ts`                                 | 新增 | 用原生高度覆盖 `--safe-area-inset-*`                         |
| `src/renderer/main.ts`                                               | 修改 | 启动时调用 `watchNativeInsets()`                             |
| `src/renderer/index.html`                                            | 修改 | viewport 加 `viewport-fit=cover`                             |
| `src/renderer/index.css`                                             | 修改 | `--safe-area-inset-*` 改为 `env()` + 原生覆盖                |
| `android/.../NowPlayingService.java`                                 | 新增 | 前台服务：系统媒体通知 + MediaSession + 音频焦点（见第十节） |
| `android/.../NowPlayingPlugin.java`                                  | 新增 | 前端 ↔ Service 的桥，回传控制指令                            |
| `android/app/src/main/res/drawable/ic_stat_music.xml`                | 新增 | 通知栏小图标（单色矢量）                                     |
| `android/app/src/main/res/values{,-en}/strings.xml`                  | 修改 | 通知渠道与按钮文案                                           |
| `android/app/src/main/AndroidManifest.xml`                           | 修改 | 前台服务声明与 3 个权限                                      |
| `src/renderer/services/nativeNowPlaying.ts`                          | 新增 | 前端侧桥接，非原生环境全 no-op                               |
| `src/renderer/services/audioService.ts`                              | 修改 | Web MediaSession 与原生共用一套 play/pause 处理              |
| `src/renderer/hooks/MusicHook.ts`                                    | 修改 | 接住原生控制指令，接到 store 的切歌方法                      |
| `resources/icon-source.png`                                          | 新增 | 图标母版（透明底 logo）                                      |
| `scripts/generate_icons.py`                                          | 新增 | 从母版生成各端图标（见第九节第 4 条）                        |
| `android/.../mipmap-*/ic_launcher{,_round,_foreground}.png`          | 修改 | 换掉 Capacitor 默认图标                                      |
| `resources/{icon.png,icon.ico,icon.icns,favicon.ico,icon_16x16.png}` | 修改 | 桌面端图标同步替换                                           |
| `src/renderer/assets/icon.png`                                       | 修改 | 应用菜单里的 logo                                            |

### 关于状态栏避让

targetSdk 35（Android 15+）起系统**强制 edge-to-edge**，页面直接画到状态栏和手势条下面。
但 Android WebView 里的 `env(safe-area-inset-*)` **只反映屏幕挖孔，取不到状态栏高度**（恒为 0），
所以顶部必然被状态栏压住 —— 光靠 CSS 解决不了。

做法：`InsetsPlugin` 读 `WindowInsetsCompat.Type.systemBars() | displayCutout()`，
换算成 CSS px 交给前端，由 `nativeInsets.ts` 写在 `:root` 的内联样式上。
内联样式优先级高于样式表里的 `env()` 声明，所以桌面端/浏览器不受影响，
Android 端则拿到真实高度。旋转屏幕会通过 `resize` 重新取一次。

预置逻辑**只在非 Electron 环境生效**，桌面端设置保持不变：

```ts
// src/renderer/store/modules/settings.ts
if (!isElectron) {
  if (!mergedSettings.customApiPlugin) {
    mergedSettings.customApiPlugin = JSON.stringify(PRESET_CUSTOM_API_PLUGIN);
    mergedSettings.customApiPluginName = PRESET_CUSTOM_API_PLUGIN.name;
  }
  const sources: string[] = mergedSettings.enabledMusicSources || [];
  if (!sources.includes('custom')) {
    mergedSettings.enabledMusicSources = ['custom', ...sources];
  }
}
```

写入位置在 `mergeWith` 之后，因此即使 `localStorage` 里已有旧设置也能生效；用户自行导入过插件则不会被覆盖。

---

## 四、构建环境

| 项目        | 值                                                |
| ----------- | ------------------------------------------------- |
| Node.js     | v26.3.1                                           |
| Capacitor   | 7.6.9                                             |
| JDK         | Temurin **21**.0.12.1（Capacitor 7 要求 Java 21） |
| Android SDK | platform 35 / build-tools 35.0.0 / platform-tools |
| AGP         | 8.7.2                                             |
| Gradle      | 8.11.1                                            |

工具链安装在 `D:/XC_workspace/musicDL/toolchain/`：

```
toolchain/
├── jdk-21.0.12.1+1/          # JDK（注意：JDK 17 会构建失败）
├── android-sdk/              # Android SDK
└── _dl/                      # 下载的压缩包，确认无误后可删（约 780MB）
```

下载源（GitHub 与 `services.gradle.org` 在本机不可达，故使用镜像）：

| 组件          | 来源                                                        |
| ------------- | ----------------------------------------------------------- |
| JDK 21        | `mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/` |
| Android SDK   | `dl.google.com`                                             |
| Gradle 8.11.1 | `mirrors.cloud.tencent.com/gradle/`                         |

Gradle 的分发地址已改写进 `android/gradle/wrapper/gradle-wrapper.properties`。

---

## 五、构建步骤

```bash
cd /d/XC_workspace/musicDL/AlgerMusicPlayer-5.1.0

# 环境变量（每次构建都需要）
export JAVA_HOME="D:/XC_workspace/musicDL/toolchain/jdk-21.0.12.1+1"
export ANDROID_HOME="D:/XC_workspace/musicDL/toolchain/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

# 1. 构建 Web 产物并同步到 Android 工程（含 .gz 清理）
npm run build:android

# 2. 打包 APK
cd android
./gradlew assembleRelease     # 正式版，已签名
./gradlew assembleDebug       # 调试版
```

产物命名规则（见 `android/app/build.gradle` 末尾的 `applicationVariants.all`）：

```
AlgerMusicPlayer-<versionName>-<yyyyMMdd-HHmm>.apk
```

版本号取自 `defaultConfig.versionName`（当前 `5.1.0`），取不到时退化为纯时间戳；非 release 的构建类型在末尾补上类型名。同一版本反复构建也能靠时间戳区分新旧包。

| 类型            | 路径                                                                            | 大小  |
| --------------- | ------------------------------------------------------------------------------- | ----- |
| release         | `android/app/build/outputs/apk/release/AlgerMusicPlayer-5.1.0-<时间戳>.apk`     | 6.2MB |
| release（副本） | `dist/AlgerMusicPlayer-5.1.0-<时间戳>.apk`                                      | 6.2MB |
| debug           | `android/app/build/outputs/apk/debug/AlgerMusicPlayer-5.1.0-<时间戳>-debug.apk` | 8.0MB |

`build:android` 只负责构建 Web 产物并同步到 Android 工程，**不打 APK**。打 APK 时 gradle 会自动把 release 包拷一份到 `dist/`（`copyReleaseApkToDist` 任务，挂在 `assembleRelease` 之后），不需要再手工 `cp`。

校验哈希（文件名带时间戳，哈希每次构建都不同，现用现算）：

```bash
sha256sum dist/AlgerMusicPlayer-5.1.0-*.apk
```

release 体积更小是因为不含调试符号。两者的 Web 资源完全一致，`minifyEnabled` 保持 `false`（Capacitor 模板默认值，开启 R8 可能破坏插件注册）。

### 安装

```bash
adb install -r "$(ls -t dist/AlgerMusicPlayer-5.1.0-*.apk | head -1)"   # 装 dist/ 里最新打的那个包
```

直接传到手机点击安装也可以。

**注意**：如先前装过官方版 APK 或本项目的 debug 版，签名不同会导致安装失败，需先卸载旧版。

---

## 六、签名配置

release 版本需要签名，已生成一套密钥：

| 项目     | 值                                                         |
| -------- | ---------------------------------------------------------- |
| 密钥文件 | `android/alger-release.keystore`                           |
| 别名     | `alger`                                                    |
| 口令     | `AlgerMusic@2026`                                          |
| 有效期   | 10000 天                                                   |
| 证书主体 | `CN=AlgerMusicPlayer, OU=Mobile, O=AlgerMusicPlayer, C=CN` |

签名信息读取自 `android/keystore.properties`：

```properties
storeFile=alger-release.keystore
storePassword=AlgerMusic@2026
keyAlias=alger
keyPassword=AlgerMusic@2026
```

`android/app/build.gradle` 中已接入（文件不存在时自动跳过签名，不影响 debug 构建）：

```gradle
def keystorePropertiesFile = rootProject.file("keystore.properties")
...
signingConfigs {
    release {
        if (keystorePropertiesFile.exists()) {
            storeFile rootProject.file(keystoreProperties['storeFile'])
            ...
        }
    }
}
```

> **密钥与口令均在 `.gitignore` 中排除**（`*.keystore`、`*.jks`、`keystore.properties`），不会随仓库提交。
>
> 但请注意：**口令以明文保存在 `keystore.properties` 中**。这套密钥仅适合个人自用与本地分发；若要上架应用商店，务必自行生成新密钥、改用强口令，并妥善离线保管——**密钥一旦丢失，将无法为已发布的应用推送更新**。

版本号在 `android/app/build.gradle` 的 `defaultConfig` 中设置，当前为 `versionCode 50100` / `versionName "5.1.0"`。

---

## 七、过程中遇到的两个构建问题

### 1. `无效的源发行版：21`

`:capacitor-android:compileDebugJavaWithJavac` 失败。Capacitor 7 要求 Java 21，最初安装的 JDK 17 不满足。改用 JDK 21 即可。

### 2. `Duplicate resources`

`:app:mergeDebugAssets` 失败，报 `x.js` 与 `x.js.gz` 重复。

原因：`vite-plugin-compression` 会为每个产物额外生成 `.gz`。WebView 直接从 assets 读取文件，用不上 gzip 副本，而 Android 的资源合并器把两者视为冲突。

处理：`scripts/prepare_android_assets.mjs` 在 `cap sync` 之后清理这些文件，已并入 `build:android` 脚本，无需手工操作。

---

## 八、验证情况

### 已验证

| 检查项              | 方法                                    | 结果                                                               |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| 音源可播性          | 直接请求接口 + 校验音频字节             | 5/5 可播，含 VIP 独家                                              |
| 插件配置格式        | 按 App 的 `parseFromCustomApi` 逻辑模拟 | 正确映射到 `data` 字段                                             |
| 公共网易 API 覆盖度 | 逐个请求 App 用到的接口                 | 17/18 通过                                                         |
| 类型检查            | `vue-tsc`（tsconfig.web.json）          | 无错误                                                             |
| 预置是否进入产物    | 在 APK 内检索关键字符串                 | 均在                                                               |
| 浏览链路            | 无头 Chrome 加载构建产物                | 成功渲染，76 处网易图片资源                                        |
| APK 签名            | `apksigner verify --print-certs`        | 签名有效，证书 `CN=AlgerMusicPlayer`（release 密钥，v1 + v2 方案） |
| 桌面端未受影响      | 预置逻辑仅 `!isElectron` 时生效         | 已确认                                                             |

### 未验证（需在真机上确认）

- **CapacitorHttp 的跨域绕过**：机制与配置均已确认存在，但仅在真机运行时才真正生效，本机无法模拟。
- **实际播放与 UI 交互**：包括后台播放、锁屏控制等。

建议安装后重点确认：搜索一首 VIP 曲目（如周杰伦《晴天》）能否播放。

---

## 九、已知限制

1. **依赖第三方公开接口，随时可能失效。** 这次的故障本身就是因为作者停服。`api-netease.ontus.cn` 与 `www.tinysignal.fun` 都不是本项目可控的。若某天失效，需要更换地址——两个地址都集中在 `src/renderer/const/music-source-preset.ts` 与 `request.ts`，改一处即可。

2. **登录功能受限**：公共接口未登录态，收藏、歌单同步等需要账号的功能大概率不可用。

3. **后台播放**：播放中会拉起 `mediaPlayback` 类型的前台服务（见第十节），进程不会被随手回收。但暂停后如果系统内存吃紧仍可能被清掉——通知栏还在，点播放时服务会重启，但 WebView 已销毁，实际放不出声。

4. **应用图标**：已替换为自定义 logo。母版是 `resources/icon-source.png`（透明底紫色 logo，宽高比约 1.37:1），
   由 `scripts/generate_icons.py` 生成 Android 各密度图标，并顺带覆盖桌面端的 `icon.png` / `icon.ico` / `icon.icns`
   以及 favicon、托盘用的 `icon_16x16.png`。换图标只需替换母版后重跑该脚本。

   自适应图标的背景层设为全透明（`ic_launcher_background = #00000000`），好处是 logo 形状不被遮罩切边，
   代价是部分启动器（尤其 Android 12+）会自行补一层底色，各机型观感不完全一致。
   若要统一，把该颜色改回 `#FFFFFF` 之类的实色即可。

5. **桌面端配置残留**：`src/main/set.json` 中的 `enabledMusicSources` 仍为 `["migu","kugou","pyncmd"]`，桌面端维持原样，未作改动。

---

## 十、通知栏媒体控制与音频焦点

> 记录日期：2026-09-18

### 为什么必须在原生侧做

WebView 里播放的 `<audio>` 不会自动生成系统媒体通知——那个通知在 Chrome 里是**浏览器自己**提供的 UI，
WebView 宿主应用不给它做就没有。前端 `audioService.ts` 其实早就实现了 Web MediaSession API，
但在 WebView 里没有 UI 载体，所以只有桌面端生效。

音频焦点同理，属于系统级 API，页面拿不到。

### 方案

用**框架自带**的 `android.media.session.MediaSession` + `Notification.MediaStyle`（API 21+，
minSdk 23 够用），**不引入任何新依赖**，也不需要 `androidx.media`。

| 文件                     | 职责                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `NowPlayingService.java` | 前台服务（`foregroundServiceType="mediaPlayback"`）：通知、MediaSession、音频焦点、封面下载  |
| `NowPlayingPlugin.java`  | Capacitor 插件 `NowPlaying`：`start` / `update` / `setPlaying` / `stop`，回传 `control` 事件 |
| `nativeNowPlaying.ts`    | 前端桥接，`Capacitor.isNativePlatform()` 守卫，非原生环境全 no-op                            |

前端只做两件事：把播放状态推给原生、把原生回来的控制指令接到既有的处理路径上。

- **推**：`audioService` 里 `updateMediaSessionMetadata/State/PositionState` 三个方法顺带转发。
  进度更新**节流到 1 秒**——原生 `PlaybackState` 会自己按 rate 外推，不需要高频同步。
- **接**：`MusicHook.initMusicHook` 里注册监听。`play`/`pause` 走 `audioService.handleMediaPlay/Pause`，
  和 Web MediaSession 是**同一份实现**（从 `initMediaSession` 里抽出来的），避免两条路径逻辑漂移；
  `next`/`prev` 走 `playerStore.nextPlay/prevPlay`。
  注册放在 `initMusicHook` 而不是 `initAudioListeners`：后者在「当前没有播放歌曲」时会提前返回。

原生平台上**跳过** Web MediaSession 注册：WebView 里的 `navigator.mediaSession` 没有 UI，
两边都注册只会互相抢媒体按键导致双触发。

### 音频焦点

请求时机：收到 `isPlaying: true` 时申请 `AUDIOFOCUS_GAIN`；服务 `onDestroy` 时放弃。
用户手动暂停**不**放弃焦点。

| 回调                                         | 处理                                        |
| -------------------------------------------- | ------------------------------------------- |
| `LOSS_TRANSIENT` / `LOSS_TRANSIENT_CAN_DUCK` | 发 `pause`，置 `resumeWhenGained`           |
| `GAIN`                                       | 若 `resumeWhenGained` → 发 `play`，清除标记 |
| `LOSS`                                       | 发 `pause`，清除标记（不自动恢复）          |

即：**短暂打断**（来电、微信/QQ 语音、导航播报、系统提示音）结束后自动续播；
**永久抢焦**（另一个音乐 App 主动播放）只暂停，不自动恢复。

`setWillPauseWhenDucked(true)`：CAN_DUCK 时也让对方直接暂停，而不是压低音量。

### 通知内容

封面（后台线程 `HttpURLConnection` 下载，`inSampleSize` 缩到 ≤512px，`LruCache` 按 URL 缓存）

- 歌名 + 歌手 + 上一首/播放暂停/下一首，`setVisibility(VISIBILITY_PUBLIC)` 锁屏可见，
  点击卡片经 `MediaSession.setSessionActivity` 回到 App。封面 http 地址会先换成 https 再试，
  失败就跳过封面（不留白块）。

通知按钮用 `PendingIntent.getService` 回调到 Service 的 `onStartCommand`，
省掉一个 `BroadcastReceiver`。`action` 定义在 Service 里，靠 `setAction` 区分。
这也带来一个便利：**Service 还没起来时用 `start()`，起来了就用 `apply()` 增量更新**，
所以插件里先 `getInstance()` 判断一次。

### 关键实现细节

- `registerPlugin(NowPlayingPlugin.class)` 必须在 `super.onCreate()` **之前**（同 `InsetsPlugin`）。
- 顺序必须是「先 `MediaSession.setActive(true)` → 再 `startForeground`」：
  Android 14/15 要求 `mediaPlayback` 类型的前台服务启动时确实在处理媒体。
- `startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)`
  是 API 29+ 才有的三参重载，低版本走两参。
- 通知小图标**必须**是单色矢量：系统只取 alpha 通道当遮罩染色，
  直接复用全彩的自适应 launcher 图标会糊成一团白块。所以单独建了 `ic_stat_music.xml`。
- `handleMediaPlay/Pause` 都先判一次 `currentSound.playing()` 再动作。
  Chromium 和原生侧可能同时收到同一次焦点变化，重复调 howler 的 `play()` 会多起一个音源实例。
- `notifyListeners("control", data, false)`：不用 `retainUntilConsumed`。
  滞留一个 `pause` 事件、下次启动时重放出来，比漏掉一次按键更糟。

### 权限

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

`POST_NOTIFICATIONS`（Android 13+）在首次播放时弹一次授权。
`NowPlayingPlugin` 上声明了 `@Permission(alias = "notifications")`，
`checkPermissions` / `requestPermissions` 由 Capacitor 的 `Plugin` 基类直接提供，不用自己写。

前端**刻意不 await** 这个授权：对话框会阻塞好几秒，等它关掉再起服务反而让通知延迟出现。
未授权时通知不显示，但前台服务与音频焦点照常工作。

### 待实机确认

| #   | 操作                     | 期望                                              |
| --- | ------------------------ | ------------------------------------------------- |
| 1   | 播放任意歌曲，下拉通知栏 | 媒体卡片：封面 + 歌名 + 歌手 + 上一首/暂停/下一首 |
| 2   | 点通知栏的暂停/播放      | App 内状态同步变化，按钮图标跟着变                |
| 3   | 点上一首/下一首          | 切歌正确，且**只切一次**                          |
| 4   | 点击卡片本体             | 回到 App 前台                                     |
| 5   | 切到桌面                 | 音乐继续放，卡片仍在且可用                        |
| 6   | 播放中接电话 / 微信语音  | 自动暂停，结束后自动恢复                          |
| 7   | 播放中打开网易云放歌     | 自动暂停；网易云停止后**不**自动恢复              |
| 8   | 播放中导航播报           | 自动暂停，播报结束恢复                            |
| 9   | 耳机/蓝牙上一首按键      | 只切一次歌                                        |

调试：

```bash
adb logcat | grep -iE "NowPlaying|AudioFocus|MediaSession"
```

> **最大风险点**：Chromium 是否也替页面申请了音频焦点。若两边同时生效会出现「暂停两次 / 恢复两次」，
> 实机验证时优先看这一条。真打架的话，`handleMediaPlay/Pause` 的幂等判断能挡住大部分，
> 再不行就让其中一侧只保留通知栏控件。

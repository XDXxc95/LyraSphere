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
  ? "http://127.0.0.1:" + (setData?.musicApiPort)
  : "http://mc.alger.fun/api";

// 音乐解析接口
const baseURL = "http://mc.alger.fun/music_proxy";
```

Android WebView 里 `window.electron` 是 `undefined`，所以两个地址都指向 `mc.alger.fun`。

实测该域名的现状：

| 检查项 | 结果 |
| --- | --- |
| DNS 解析 | 正常，`110.42.251.190` |
| ping | 通，约 21ms（本机网络无问题） |
| 80 端口（APK 用的） | **TCP 超时，无服务** |
| 443 端口 | 端口开着，但证书 `CN=www.alger.fun` 已于 **2026-07-10 过期** |
| `https://mc.alger.fun/` | 返回一个**下载页**，`/api` 全部 404 |

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

| 音源 | 地址 | 支持平台 | CORS | 实测 |
| --- | --- | --- | --- | --- |
| SodaMusic | `www.tinysignal.fun/soda_music/music_action_v2.php` | 网易 + 酷我/酷狗兜底 | ✗ | **5/5 可播，含 VIP 独家** |
| 公共网易 API | `api-netease.ontus.cn` | 网易 | `*` | 浏览接口 17/18 通过 |
| GD音乐台 | `music-api.gdstudio.xyz/api.php` | netease/kuwo/joox | `*` | 热榜 40/40，独家 ✗ |
| Meting | `api.injahow.cn/meting/` | netease/kuwo/tencent | `*` | 独家需酷我 ID，不通用 |

### 关于 SodaMusic 音源

来自参考包 `薄荷音乐220.apk`（Flutter 应用），其接口常量位于 `lib/arm64-v8a/libapp.so`：

```
music_action_v2.php?action=getAlgerListenUrl&linkMid=
```

该接口接收网易歌曲 ID，在后端完成跨平台匹配（网易取不到时回退到酷我），无需签名鉴权。实测：

| 歌曲 | 结果 |
| --- | --- |
| 周杰伦《晴天》(186016，VIP 独家) | ✓ 10.29MB（酷我源） |
| 周杰伦《晴天》via GD音乐台 | ✗ 返回空 |
| 孙燕姿《我不难过》 | ✓ 12.23MB |
| 网易热榜 #1 | ✓ 6.77MB |

GD音乐台 / Meting 都拿不到周杰伦这类独家版权曲目，SodaMusic 可以——因为它在后端做了跨平台匹配。这一点与桌面端 `@unblockneteasemusic/server` 的能力一致（实测本地引擎同样通过酷我命中该曲）。

### 关于 CORS

SodaMusic 接口**不返回** `Access-Control-Allow-Origin`，WebView 里常规 XHR 会被拦截。Android 工程中已启用 `CapacitorHttp`，请求改走原生 HTTP，绕过 CORS 限制（Flutter 参考包是原生的，本身不受此限制）。

---

## 三、采用的方案

保持"不使用自建后端、只用公开音源"的前提下，改动如下。

| 层 | 方案 |
| --- | --- |
| 浏览（歌单/搜索/歌词） | 指向公共网易 API `api-netease.ontus.cn` |
| 播放（含 VIP 解锁） | 预置 SodaMusic 为「自定义API」音源 |
| 跨域 | 启用 `CapacitorHttp` |
| 兜底 | 自定义音源失败时，仍走官方 `/song/url/v1`（免费歌曲可用） |

### 代码改动清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/renderer/const/music-source-preset.ts` | 新增 | 预置音源定义 + 网易接口兜底地址 |
| `src/renderer/store/modules/settings.ts` | 修改 | 非 Electron 环境下自动注入预置音源 |
| `src/renderer/utils/request.ts` | 修改 | `VITE_API` 未配置时回退到公共接口 |
| `src/renderer/api/musicParser.ts` | 修改 | 非 Electron 的解析回退改为先试自定义音源 |
| `capacitor.config.ts` | 新增 | Capacitor 配置，启用 CapacitorHttp |
| `scripts/prepare_android_assets.mjs` | 新增 | 清理 `.gz` 文件（见第七节） |
| `package.json` | 修改 | 新增 `build:android` 脚本 |

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

| 项目 | 值 |
| --- | --- |
| Node.js | v26.3.1 |
| Capacitor | 7.6.9 |
| JDK | Temurin **21**.0.12.1（Capacitor 7 要求 Java 21） |
| Android SDK | platform 35 / build-tools 35.0.0 / platform-tools |
| AGP | 8.7.2 |
| Gradle | 8.11.1 |

工具链安装在 `D:/XC_workspace/musicDL/toolchain/`：

```
toolchain/
├── jdk-21.0.12.1+1/          # JDK（注意：JDK 17 会构建失败）
├── android-sdk/              # Android SDK
└── _dl/                      # 下载的压缩包，确认无误后可删（约 780MB）
```

下载源（GitHub 与 `services.gradle.org` 在本机不可达，故使用镜像）：

| 组件 | 来源 |
| --- | --- |
| JDK 21 | `mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/` |
| Android SDK | `dl.google.com` |
| Gradle 8.11.1 | `mirrors.cloud.tencent.com/gradle/` |

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

产物：

| 类型 | 路径 | 大小 |
| --- | --- | --- |
| release | `android/app/build/outputs/apk/release/app-release.apk` | 6.2MB |
| release（副本） | `dist/AlgerMusicPlayer-5.1.0-android-release.apk` | 6.2MB |
| debug | `android/app/build/outputs/apk/debug/app-debug.apk` | 8.0MB |

`build:android` 只负责构建 Web 产物并同步到 Android 工程，**不打 APK、也不会拷贝到 `dist/`**；`dist/` 下的那份 release 副本是打包完成后手工拷贝的（`cp` 一条命令），列出来是为了让 `adb install` 有固定路径可用。

release 副本的 SHA-256：

```
e24b1e5b8d6d964dcafe20c2c9500bc5694a94f5b8a225b5ca4129b3ccebacb2
```

release 体积更小是因为不含调试符号。两者的 Web 资源完全一致，`minifyEnabled` 保持 `false`（Capacitor 模板默认值，开启 R8 可能破坏插件注册）。

### 安装

```bash
adb install -r dist/AlgerMusicPlayer-5.1.0-android-release.apk
```

直接传到手机点击安装也可以。

**注意**：如先前装过官方版 APK 或本项目的 debug 版，签名不同会导致安装失败，需先卸载旧版。

---

## 六、签名配置

release 版本需要签名，已生成一套密钥：

| 项目 | 值 |
| --- | --- |
| 密钥文件 | `android/alger-release.keystore` |
| 别名 | `alger` |
| 口令 | `AlgerMusic@2026` |
| 有效期 | 10000 天 |
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

| 检查项 | 方法 | 结果 |
| --- | --- | --- |
| 音源可播性 | 直接请求接口 + 校验音频字节 | 5/5 可播，含 VIP 独家 |
| 插件配置格式 | 按 App 的 `parseFromCustomApi` 逻辑模拟 | 正确映射到 `data` 字段 |
| 公共网易 API 覆盖度 | 逐个请求 App 用到的接口 | 17/18 通过 |
| 类型检查 | `vue-tsc`（tsconfig.web.json） | 无错误 |
| 预置是否进入产物 | 在 APK 内检索关键字符串 | 均在 |
| 浏览链路 | 无头 Chrome 加载构建产物 | 成功渲染，76 处网易图片资源 |
| APK 签名 | `apksigner verify --print-certs` | 签名有效，证书 `CN=AlgerMusicPlayer`（release 密钥，v1 + v2 方案） |
| 桌面端未受影响 | 预置逻辑仅 `!isElectron` 时生效 | 已确认 |

### 未验证（需在真机上确认）

- **CapacitorHttp 的跨域绕过**：机制与配置均已确认存在，但仅在真机运行时才真正生效，本机无法模拟。
- **实际播放与 UI 交互**：包括后台播放、锁屏控制等。

建议安装后重点确认：搜索一首 VIP 曲目（如周杰伦《晴天》）能否播放。

---

## 九、已知限制

1. **依赖第三方公开接口，随时可能失效。** 这次的故障本身就是因为作者停服。`api-netease.ontus.cn` 与 `www.tinysignal.fun` 都不是本项目可控的。若某天失效，需要更换地址——两个地址都集中在 `src/renderer/const/music-source-preset.ts` 与 `request.ts`，改一处即可。

2. **登录功能受限**：公共接口未登录态，收藏、歌单同步等需要账号的功能大概率不可用。

3. **后台播放**：本次未接入 `@jofr/capacitor-media-session` 等插件，切到后台或被系统回收时播放可能中断。

4. **应用图标**：当前为 Capacitor 默认图标。可用 `@capacitor/assets` 从 `resources/icon.png` 生成各密度图标。

5. **桌面端配置残留**：`src/main/set.json` 中的 `enabledMusicSources` 仍为 `["migu","kugou","pyncmd"]`，桌面端维持原样，未作改动。

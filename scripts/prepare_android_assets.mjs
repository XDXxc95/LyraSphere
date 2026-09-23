/**
 * 打包 Android 前的资源清理
 *
 * 1. vite-plugin-compression 会为每个产物额外生成 .gz 文件，
 *    而 Android 的资源合并器把 `x.js` 与 `x.js.gz` 视为重复资源，
 *    会导致 mergeDebugAssets 失败。WebView 直接从 assets 读取文件，
 *    用不上 gzip 副本，这里统一清掉。
 *
 * 2. `resources/` 是 vite 的 publicDir，里面的桌面端图标会跟着一起被
 *    cap sync 拷进 APK。这些文件（icns / ico / 图标源图 / 托盘小图）
 *    只有 Electron 打包和图标生成脚本用得上，WebView 一个都不读，
 *    白占约 1MB。**只删 APK 里的副本，仓库里的原文件保持不动**——
 *    electron-builder 的 mac/win/linux icon 和 generate_icons.py 都依赖它们。
 */
import { readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

const ASSETS_ROOT = join('android', 'app', 'src', 'main', 'assets', 'public');

/** 只服务桌面端 / 图标生成流程，WebView 用不到的文件 */
const DESKTOP_ONLY = [
  'icon.icns', // electron-builder: mac 应用图标
  'icon.ico', // electron-builder: win 安装包图标
  'icon-source.png', // scripts/generate_icons.py 的输入源图
  'icon_16x16.png' // Electron 托盘图标
];

/** 只服务桌面端 / 图标生成流程的目录（整体删除） */
const DESKTOP_ONLY_DIRS = [
  'icons' // Electron 托盘播放控制小图（tray.ts 从 app.getAppPath() 读，不走这里）
];

function removeGzipFiles(dir) {
  let removed = 0;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);

    if (statSync(fullPath).isDirectory()) {
      removed += removeGzipFiles(fullPath);
    } else if (entry.endsWith('.gz')) {
      rmSync(fullPath);
      removed++;
    }
  }

  return removed;
}

try {
  statSync(ASSETS_ROOT);
} catch {
  console.error(`未找到 ${ASSETS_ROOT}，请先执行 npx cap sync android`);
  process.exit(1);
}

/** 返回删掉的字节数，顺便把文件移走 */
function removeDesktopOnly() {
  let bytes = 0;
  const removedNames = [];

  for (const name of DESKTOP_ONLY) {
    const fullPath = join(ASSETS_ROOT, name);
    try {
      bytes += statSync(fullPath).size;
      rmSync(fullPath);
      removedNames.push(name);
    } catch {
      // 文件不存在就算了，没必要为此中断打包
    }
  }

  for (const name of DESKTOP_ONLY_DIRS) {
    const fullPath = join(ASSETS_ROOT, name);
    try {
      for (const entry of readdirSync(fullPath)) {
        bytes += statSync(join(fullPath, entry)).size;
      }
      rmSync(fullPath, { recursive: true });
      removedNames.push(`${name}/`);
    } catch {
      // 同上
    }
  }

  return { bytes, removedNames };
}

const removed = removeGzipFiles(ASSETS_ROOT);
console.log(`已清理 ${removed} 个 .gz 文件: ${ASSETS_ROOT}`);

const desktop = removeDesktopOnly();
if (desktop.removedNames.length) {
  const kb = (desktop.bytes / 1024).toFixed(0);
  console.log(`已从 APK 移除桌面端专属资源 ${desktop.removedNames.join(', ')} (约 ${kb}KB)`);
}


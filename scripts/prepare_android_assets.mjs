/**
 * 打包 Android 前的资源清理
 *
 * vite-plugin-compression 会为每个产物额外生成 .gz 文件，
 * 而 Android 的资源合并器把 `x.js` 与 `x.js.gz` 视为重复资源，
 * 会导致 mergeDebugAssets 失败。WebView 直接从 assets 读取文件，
 * 用不上 gzip 副本，这里统一清掉。
 */
import { readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

const ASSETS_ROOT = join('android', 'app', 'src', 'main', 'assets', 'public');

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

const removed = removeGzipFiles(ASSETS_ROOT);
console.log(`已清理 ${removed} 个 .gz 文件: ${ASSETS_ROOT}`);

import { app, ipcMain, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';

import { clearLog, getLogInfo, writeLog } from './appLog';

/**
 * 排障用：把 {@link writeLog} 写出来的日志交给用户。桌面端的三个出路和 Android 的
 * DiagnosticsPlugin 一一对应，只是动作换成了这个平台上的等价物：
 *
 * 1. `open-folder` —— 让资源管理器打开日志目录（Android 上要先导出到 Download，
 *    因为应用私有目录用户够不着；Windows 上没这回事，直接打开即可）；
 * 2. `export`     —— 复制一份到下载目录，文件名带时间戳，用来发给开发者；
 * 3. `share`      —— 桌面没有系统分享面板，等价动作是导出 + 在资源管理器里选中该文件。
 */

/** 导出到下载目录下的子目录名 */
const EXPORT_DIR = 'LyraSphere';

const fileStamp = () => {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
};

/** 复制一份日志到下载目录，返回落点。多次导出不会互相覆盖（文件名带时间戳）。 */
const exportLog = () => {
  const info = getLogInfo();
  if (!info.exists) throw new Error('日志文件还不存在');

  const dir = join(app.getPath('downloads'), EXPORT_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const target = join(dir, `lyra-${fileStamp()}.log`);
  copyFileSync(info.path, target);

  return { path: target, sizeBytes: statSync(target).size };
};

export const initializeDiagnostics = () => {
  /**
   * 渲染进程 console 转发进来的日志。
   * 前端会攒一批用 \n 拼起来发，这里逐行写，保证每行都有自己的时间戳。
   */
  ipcMain.handle(
    'diagnostics:log',
    (_event, payload: { message?: string; level?: string; tag?: string } | undefined) => {
      const message = payload?.message ?? '';
      if (!message) return;

      const level = (payload?.level ?? 'I') as 'I' | 'D' | 'W' | 'E';
      writeLog(level, payload?.tag ?? 'WebView', message);
    }
  );

  ipcMain.handle('diagnostics:info', () => getLogInfo());

  ipcMain.handle('diagnostics:clear', () => {
    clearLog();
    writeLog('I', 'Diagnostics', '日志已清空');
  });

  ipcMain.handle('diagnostics:export', () => {
    try {
      const exported = exportLog();
      return { path: exported.path, sizeBytes: exported.sizeBytes, supported: true };
    } catch (error) {
      writeLog('E', 'Diagnostics', `导出日志失败: ${String(error)}`);
      throw error;
    }
  });

  ipcMain.handle('diagnostics:open-folder', async () => {
    const info = getLogInfo();

    try {
      // openPath 成功时返回空串，失败返回错误描述
      const failure = await shell.openPath(info.dir);
      if (!failure) return { opened: true, path: info.dir };

      writeLog('W', 'Diagnostics', `打开日志目录失败(${failure})，改为导出并定位文件`);
    } catch (error) {
      writeLog('W', 'Diagnostics', `打开日志目录异常: ${String(error)}`);
    }

    // 没有文件管理器/关联异常时退回：导出到下载目录并在资源管理器里选中它，
    // 用户照样能拿到文件
    const exported = exportLog();
    shell.showItemInFolder(exported.path);
    return { opened: false, path: exported.path };
  });

  ipcMain.handle('diagnostics:share', () => {
    const exported = exportLog();
    shell.showItemInFolder(exported.path);
    return { path: exported.path };
  });
};

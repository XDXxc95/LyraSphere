import { ipcMain } from 'electron';
import Store from 'electron-store';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { type Platform, unblockMusic } from './unblockMusic';

// 必须在 import netease-cloud-music-api-alger 之前创建 anonymous_token 文件
// 否则模块加载时 readFileSync 会因文件不存在而崩溃
if (!fs.existsSync(path.resolve(os.tmpdir(), 'anonymous_token'))) {
  fs.writeFileSync(path.resolve(os.tmpdir(), 'anonymous_token'), '', 'utf-8');
}

const store = new Store();

// 设置音乐解析的处理程序
ipcMain.handle('unblock-music', async (_event, id, songData, enabledSources) => {
  try {
    const result = await unblockMusic(id, songData, 1, enabledSources as Platform[]);
    return result;
  } catch (error) {
    console.error('音乐解析失败:', error);
    return { error: (error as Error).message || '未知错误' };
  }
});

/** 音乐 API 只监听回环地址，避免对局域网暴露 */
const API_HOST = '127.0.0.1';

/**
 * 检查端口是否可用。
 *
 * 探测必须绑定到和 serveNcmApi 同一个地址（127.0.0.1），不能图省事只写端口号：
 * 只写端口时监听的是通配地址，而 Windows 上 SO_REUSEADDR 的语义允许通配绑定和
 * 已存在的具体地址绑定并存，探测会误报「端口可用」，紧接着真正 listen 才炸
 * EADDRINUSE。
 */
function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const tester = net
      .createServer()
      .once('error', () => {
        resolve(false);
      })
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, API_HOST);
  });
}

/**
 * 兜住「端口被占」这类 bind 错误。
 *
 * api 包内部的 listen 没有挂 error 监听，bind 失败会冒成**未捕获异常**；而 Electron
 * 对未捕获异常的默认处理是弹一个**同步**模态框，整个主进程连同事件循环一起冻住——
 * 窗口不出现、`did-finish-load` 不触发、渲染进程日志一条都收不到，用户只看到应用
 * 打不开。这里只认端口类错误：记一条日志让应用照常起来（界面自己会说音乐服务不可用），
 * 其余异常原样抛回去，保持默认行为不变。
 */
const isPortError = (error: NodeJS.ErrnoException) =>
  error?.code === 'EADDRINUSE' || error?.code === 'EACCES';

const installPortErrorGuard = () => {
  const handler = (error: NodeJS.ErrnoException) => {
    if (isPortError(error)) {
      console.error(`音乐 API 端口不可用（${error.code}），本次运行不启动音乐服务:`, error.message);
      return;
    }

    // 先把监听摘掉再抛，否则会被自己再兜一次
    process.removeListener('uncaughtException', handler);
    process.nextTick(() => {
      throw error;
    });
  };

  process.on('uncaughtException', handler);
};

async function startMusicApi(): Promise<void> {
  console.log('MUSIC API STARTING...');

  // 必须在 require/serve 之前装上：异常是从 api 包内部的 listen 冒出来的异步异常，
  // 外层的 try/catch 接不住
  installPortErrorGuard();

  const settings = store.get('set') as any;
  const originalPort = settings?.musicApiPort || 30488;
  const maxRetries = 10;

  // 检查端口是否可用，如果不可用则尝试下一个端口
  let port = originalPort;
  let available = false;
  for (let i = 0; i < maxRetries; i++) {
    if (await checkPortAvailable(port)) {
      available = true;
      break;
    }
    console.log(`端口 ${port} 被占用，尝试切换到端口 ${port + 1}`);
    port++;
  }

  // 原来这里没有这个分支：10 个端口全被占时循环照常退出，然后拿最后一个仍然被占的
  // 端口去 listen，必然 EADDRINUSE
  if (!available) {
    console.error(`连续 ${maxRetries} 个端口都被占用，音乐 API 未启动（${originalPort}~${port}）`);
    return;
  }

  // 如果端口发生变化，保存新端口到配置
  if (port !== originalPort) {
    console.log(`端口从 ${originalPort} 切换到 ${port}`);
    store.set('set', { ...settings, musicApiPort: port });
  }

  try {
    const server = require('netease-cloud-music-api-alger/server');
    await server.serveNcmApi({
      port,
      // 安全默认值：仅监听本机回环地址，避免对局域网暴露
      host: API_HOST
    });
    console.log(`MUSIC API STARTED on port ${port}`);
  } catch (error) {
    console.error(`MUSIC API 启动失败:`, error);
    throw error;
  }
}

export { startMusicApi };

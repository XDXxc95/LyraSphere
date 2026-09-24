import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 排障日志桥。
 *
 * 把 WebView 里的 console 输出转发到落盘的那一份日志，和各自平台上的原生/主进程日志
 * （Android：音频焦点、MediaSession 的 AppLog.java；桌面：Electron 主进程的 appLog.ts）
 * 汇到同一个文件，这样播放链路出问题时，一条时间线就能看出是哪一段断的。
 *
 * 两端能力一样，具体出口不同：原生走 Capacitor 的 Diagnostics 插件，桌面走
 * preload 暴露的 `window.api.diagnostics*`。都不成立（浏览器里跑 dev）时全部 no-op，
 * 只是普通的 console。
 */

interface DiagnosticsPlugin {
  log(options: { message: string; level?: string; tag?: string }): Promise<void>;
  info(): Promise<{ path: string; dir: string; sizeBytes: number; exists: boolean }>;
  clearLog(): Promise<void>;
  exportLog(): Promise<{ uri: string; path: string; sizeBytes: number; supported: boolean }>;
  openLogFolder(): Promise<{ opened: boolean; path: string }>;
  shareLog(): Promise<void>;
}

export interface LogInfo {
  path: string;
  dir: string;
  sizeBytes: number;
  exists: boolean;
}

export interface LogExportResult {
  path: string;
  sizeBytes: number;
  supported: boolean;
}

/** 两端各有一套出口，这里收敛成同一组动作，上层就不用到处判平台 */
interface DiagnosticsBridge {
  log(payload: { message: string; level?: string; tag?: string }): Promise<void>;
  info(): Promise<LogInfo>;
  clearLog(): Promise<void>;
  exportLog(): Promise<LogExportResult>;
  openLogFolder(): Promise<{ opened: boolean; path: string }>;
  shareLog(): Promise<void>;
}

const capacitorPlugin = registerPlugin<DiagnosticsPlugin>('Diagnostics');

const capacitorBridge: DiagnosticsBridge | null = Capacitor.isNativePlatform()
  ? {
      log: (payload) => capacitorPlugin.log(payload),
      info: () => capacitorPlugin.info(),
      clearLog: () => capacitorPlugin.clearLog(),
      exportLog: () => capacitorPlugin.exportLog(),
      openLogFolder: () => capacitorPlugin.openLogFolder(),
      shareLog: () => capacitorPlugin.shareLog()
    }
  : null;

/** 桌面端：preload 里的 diagnostics 接口。浏览器里 `window.api` 不存在，得到 null。 */
const electronBridge: DiagnosticsBridge | null = (() => {
  const api = (window as any)?.api;
  if (typeof api?.diagnosticsLog !== 'function') return null;

  return {
    log: (payload) => api.diagnosticsLog(payload),
    info: () => api.diagnosticsInfo(),
    clearLog: () => api.diagnosticsClear(),
    exportLog: () => api.diagnosticsExport(),
    openLogFolder: () => api.diagnosticsOpenFolder(),
    shareLog: () => api.diagnosticsShare()
  };
})();

const bridge = capacitorBridge ?? electronBridge;

/** 攒一批再发，避免每条 console 都过一次 IPC/bridge */
const FLUSH_INTERVAL_MS = 300;
/** 队列上限，超了丢最旧的——排障关心的是最近发生了什么 */
const MAX_QUEUE = 2000;
/** 连续失败多少次就认定 bridge 不通，停止转发 */
const MAX_FAILURES = 3;

const queue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 连续失败次数，到阈值就彻底停掉转发（见 flush 里的说明） */
let failures = 0;
let disabled = false;

type Level = 'I' | 'D' | 'W' | 'E';

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    // 循环引用等序列化失败的情况，退回到 String()
    return String(value);
  }
};

const flush = () => {
  flushTimer = null;
  if (disabled || queue.length === 0 || !bridge) return;

  const batch = queue.splice(0, queue.length).join('\n');
  bridge
    .log({ message: batch, tag: 'WebView' })
    .then(() => {
      failures = 0;
    })
    .catch(() => {
      // bridge 调不通时，插件自己会 console.warn，而我们劫持了 console——
      // 那条警告又会被收进来重发，形成周期性的死循环。连续几次都发不出去，
      // 说明这条路本来就不通，直接停掉，别拿它拖累业务。
      if (++failures >= MAX_FAILURES) {
        disabled = true;
        queue.length = 0;
      }
    });
};

const enqueue = (level: Level, args: unknown[]) => {
  if (disabled || !bridge) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(`[${level}] ${args.map(stringify).join(' ')}`);

  if (flushTimer === null) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
};

/** 原样保留原有的 console 行为，只在旁边多写一份 */
const patchConsole = () => {
  const originals = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const wrap = (method: 'log' | 'info' | 'warn' | 'error', level: Level) => {
    console[method] = (...args: unknown[]) => {
      originals[method](...args);
      enqueue(level, args);
    };
  };

  wrap('log', 'I');
  wrap('info', 'I');
  wrap('warn', 'W');
  wrap('error', 'E');
};

/**
 * 安装日志采集。要在应用启动的最早期调用，否则会漏掉启动阶段的输出。
 */
export const installAppLog = () => {
  if (!bridge) return;

  patchConsole();

  window.addEventListener('error', (event) => {
    enqueue('E', [
      `未捕获错误: ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`
    ]);
  });

  window.addEventListener('unhandledrejection', (event) => {
    enqueue('E', [`未处理的 Promise 拒绝: ${stringify(event.reason)}`]);
  });

  enqueue('I', ['===== 渲染进程日志采集已启动 =====']);
};

export const isAppLogAvailable = bridge !== null;

export const getLogInfo = async (): Promise<LogInfo | null> => {
  if (!bridge) return null;
  try {
    return await bridge.info();
  } catch {
    return null;
  }
};

export const clearAppLog = async () => {
  if (!bridge) return;
  await bridge.clearLog();
};

/**
 * 导出到下载目录。
 * 返回 opened 表示是否成功用文件管理器打开了目录/定位到文件——Android 上打开目录
 * 没有统一入口、桌面端也可能没有文件管理器关联，失败时调用方应退回分享（仅原生）。
 */
export const openAppLogFolder = async (): Promise<{ opened: boolean; path: string }> => {
  if (!bridge) return { opened: false, path: '' };
  try {
    return await bridge.openLogFolder();
  } catch {
    return { opened: false, path: '' };
  }
};

/** 复制一份日志到下载目录，用来发给开发者 */
export const exportAppLog = async (): Promise<LogExportResult | null> => {
  if (!bridge) return null;
  try {
    const result = await bridge.exportLog();
    return { path: result.path, sizeBytes: result.sizeBytes, supported: result.supported };
  } catch {
    return null;
  }
};

export const shareAppLog = async () => {
  if (!bridge) return;
  await bridge.shareLog();
};

import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 排障日志桥。
 *
 * 把 WebView 里的 console 输出转发到原生 AppLog，和原生侧（音频焦点、MediaSession）
 * 的日志汇到同一个文件，这样播放链路出问题时，一条时间线就能看出是哪一段断的。
 *
 * 非原生环境（桌面端 / 浏览器）全部 no-op，只是普通的 console。
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

const plugin = registerPlugin<DiagnosticsPlugin>('Diagnostics');
const isNative = Capacitor.isNativePlatform();

/** 攒一批再发，避免每条 console 都过一次 bridge */
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
  if (disabled || queue.length === 0) return;

  const batch = queue.splice(0, queue.length).join('\n');
  plugin
    .log({ message: batch, tag: 'WebView' })
    .then(() => {
      failures = 0;
    })
    .catch(() => {
      // 插件调不通时，Capacitor 自己会 console.warn，而我们劫持了 console——
      // 那条警告又会被收进来重发，形成周期性的死循环。连续几次都发不出去，
      // 说明这条路本来就不通，直接停掉，别拿它拖累业务。
      if (++failures >= MAX_FAILURES) {
        disabled = true;
        queue.length = 0;
      }
    });
};

const enqueue = (level: Level, args: unknown[]) => {
  if (disabled) return;
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
  if (!isNative) return;

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

export const isAppLogAvailable = isNative;

export const getLogInfo = async (): Promise<LogInfo | null> => {
  if (!isNative) return null;
  try {
    return await plugin.info();
  } catch {
    return null;
  }
};

export const clearAppLog = async () => {
  if (!isNative) return;
  await plugin.clearLog();
};

/**
 * 导出到公共 Download 目录。
 * 返回 opened 表示是否成功用文件管理器打开了目录——Android 上打开目录没有统一入口，
 * 各家文件管理器支持不一，失败时调用方应退回分享。
 */
export const openAppLogFolder = async (): Promise<{ opened: boolean; path: string }> => {
  if (!isNative) return { opened: false, path: '' };
  try {
    return await plugin.openLogFolder();
  } catch {
    return { opened: false, path: '' };
  }
};

export const shareAppLog = async () => {
  if (!isNative) return;
  await plugin.shareLog();
};

import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';

import { getSystemInfo } from './deviceInfo';

/**
 * 主进程侧的极简文件日志，和 Android 的 AppLog.java 是同一套东西。
 *
 * 存在的意义是排障：Windows 上打出来的包没有控制台，渲染进程那一堆 console.log
 * （audioService 的播放链路、howler 的状态）离开 dev 模式就全被丢掉了，用户报障时
 * 无据可查。落进文件之后，在「设置 → 关于 → 诊断日志」里一键打开目录即可。
 *
 * 位置：`<userData>/logs/lyra.log`，Windows 上就是 `%APPDATA%\Lyra Sphere\logs`。
 * 格式和 Android 端保持一致（`MM-dd HH:mm:ss.SSS I/Tag: message`），
 * 跨端对齐时间线时不用换算。
 */

const DIR_NAME = 'logs';
const FILE_NAME = 'lyra.log';
/**
 * 显示名。不能用 `app.getName()`——那读的是 package.json 的 `name`（AlgerMusicPlayer，
 * 上游留下的），而打包出去的产品叫 Lyra Sphere。给 package.json 加顶层 `productName`
 * 能让 app.getName() 变对，但 Electron 的 userData 目录也跟着按它算，老用户的曲库和
 * 设置会留在旧目录里等于丢了。所以照 tray/TitleBar 的做法写本地常量。
 */
const APP_NAME = 'Lyra Sphere';
/** 单文件上限，超了就轮转出一份 .1 备份，避免长期运行把磁盘写满 */
const MAX_BYTES = 2 * 1024 * 1024;

let logFilePath: string | null = null;
let installed = false;

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** MM-dd HH:mm:ss.SSS，和 AppLog.java 的 SimpleDateFormat 对齐 */
const timestamp = () => {
  const now = new Date();
  return (
    `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    `${pad(now.getMilliseconds(), 3)}`
  );
};

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

/**
 * 出错时用 process.stderr 而不是 console——console 在本模块里被劫持过，
 * 拿它报错会绕回写入流程，目录一直建不出来就是死循环。
 */
const reportInternalError = (message: string, error: unknown) => {
  process.stderr.write(`[appLog] ${message}: ${stringify(error)}\n`);
};

const resolveLogFile = (): string | null => {
  if (logFilePath) return logFilePath;
  try {
    const dir = join(app.getPath('userData'), DIR_NAME);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    logFilePath = join(dir, FILE_NAME);
    return logFilePath;
  } catch (error) {
    // 拿不到目录就静默丢弃后续写入，日志不该成为新的错误源
    reportInternalError('日志目录创建失败，本次运行不落盘', error);
    return null;
  }
};

const rotateIfNeeded = (file: string) => {
  if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;

  const backup = `${file}.1`;
  rmSync(backup, { force: true });
  renameSync(file, backup);
};

/**
 * 已知的凭据键名，长名在前——`access_token` 要排在 `token` 前面，否则先被短名截胡。
 */
const SENSITIVE_KEYS = [
  'SESSDATA',
  'DedeUserID__ckMd5',
  'DedeUserID',
  'bili_jct',
  'bili_ticket',
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'Authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'Cookie'
];

/**
 * 键名后跟 `=` 或 `:`（JSON 里键还带引号），把值换成 ***。
 * 值不吞引号、分号、逗号和空白，正好在 cookie 的 `; ` 和 JSON 的 `","` 处收住。
 */
const REDACT_PATTERN = new RegExp(
  `(${SENSITIVE_KEYS.join('|')})("?\\s*[=:]\\s*"?)([^";&,\\s]+)`,
  'g'
);

/**
 * 键名里就带 uid 的（B站的 `bp_t_offset_47099129`）——uid 不在值上，值脱敏够不着，
 * 得单独把键名里的数字遮掉。
 */
const UID_IN_KEY_PATTERN = /\b(bp_t_offset)_\d+/g;

/**
 * 日志脱敏。
 *
 * 主进程会把整个 cookie 串、请求头、配置项直接 console.log 出来（B站那串
 * `SESSDATA=…; bili_jct=…` 就是），这些会原样写进日志文件。用户把日志发出来排障时，
 * 等于把账号凭据一起发了，所以落盘前先遮一道。
 *
 * 只认已知键名，不做通用识别——目标是挡住「随手一条 console.log 带货」这类，
 * 真要有人手写一段不含键名的裸串，这里拦不住，也不值得为它把日志变得不可读。
 */
const redact = (text: string) =>
  text.replace(UID_IN_KEY_PATTERN, '$1_***').replace(REDACT_PATTERN, (_match, key, sep) => `${key}${sep}***`);

/**
 * 写一行。异常一律吞掉——日志本身不该成为新的崩溃源。
 */
export const writeLog = (level: 'I' | 'D' | 'W' | 'E', tag: string, message: string) => {
  const file = resolveLogFile();
  if (!file) return;

  try {
    rotateIfNeeded(file);

    let text = '';
    for (const line of redact(String(message)).split('\n')) {
      if (line) text += `${timestamp()} ${level}/${tag}: ${line}\n`;
    }
    if (text) appendFileSync(file, text, 'utf8');
  } catch (error) {
    reportInternalError('写日志失败', error);
  }
};

export const getLogInfo = () => {
  const file = resolveLogFile();
  if (!file) {
    return { path: '', dir: '', sizeBytes: 0, exists: false };
  }

  const exists = existsSync(file);
  return {
    path: file,
    dir: join(app.getPath('userData'), DIR_NAME),
    sizeBytes: exists ? statSync(file).size : 0,
    exists
  };
};

export const clearLog = () => {
  const file = resolveLogFile();
  if (!file) return;

  try {
    rmSync(file, { force: true });
    rmSync(`${file}.1`, { force: true });
  } catch (error) {
    reportInternalError('清空日志失败', error);
  }
};

/** 每次冷启动插一段环境信息，方便判断日志是哪个版本、哪台机器跑的 */
const appendHeader = () => {
  const info = getSystemInfo();
  const versions = process.versions;

  const header = [
    '',
    '========== 会话开始 ==========',
    `App: ${APP_NAME} ${info.appVersion}`,
    `Electron: ${versions.electron} (Chromium ${versions.chrome}, Node ${versions.node})`,
    `Platform: ${info.platform} ${info.osArch} ${info.osType} ${info.osVersion}`
  ].join('\n');

  writeLog('I', 'AppLog', header);
};

/**
 * 开启主进程 console 采集。要尽早调用，否则会漏掉启动阶段的输出。
 * 幂等；控制台输出原样保留（dev 模式下还看得见），只在旁边多写一份。
 */
export const installAppLog = () => {
  if (installed) return;
  installed = true;

  appendHeader();

  const originals = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const wrap = (method: 'log' | 'info' | 'warn' | 'error', level: 'I' | 'W' | 'E') => {
    console[method] = (...args: unknown[]) => {
      originals[method](...args);
      writeLog(level, 'Main', args.map(stringify).join(' '));
    };
  };

  wrap('log', 'I');
  wrap('info', 'I');
  wrap('warn', 'W');
  wrap('error', 'E');
};

/**
 * 非 Electron 环境（Web / Android）的预置音源
 *
 * 桌面端有本地解锁服务（@unblockneteasemusic/server）兜底，
 * 但 Web 与 Android 端没有主进程，播放地址完全依赖远端接口。
 * 这里预置一个公开音源，保证移动端开箱即可播放。
 */

/** 非 Electron 环境的网易云接口兜底地址，构建时配置的 VITE_API 优先级更高 */
export const FALLBACK_NETEASE_API = 'https://api-netease.ontus.cn';

/** 预置的自定义音源插件，取歌曲播放地址 */
export const PRESET_CUSTOM_API_PLUGIN = {
  name: 'SodaMusic',
  // 主机名不能带 www。该站证书的 SAN 只有 DNS:tinysignal.fun，带 www 时 Android 原生
  // HTTP（CapacitorHttp → OkHttp）的主机名校验会直接拒绝，日志里表现为
  // AxiosError: Network Error，整条音源链路全灭。
  apiUrl: 'https://tinysignal.fun/soda_music/music_action_v2.php',
  method: 'GET',
  params: {
    action: 'getAlgerListenUrl',
    linkMid: '{songId}'
  },
  responseUrlPath: 'data'
} as const;

/**
 * 预置插件用过的历史地址。
 *
 * 老版本已经把这个插件写进了本地存储，光改上面的常量对存量用户不生效，初始化时要按这张表迁一次。
 * 只认这里列出的确切地址，用户自己导入的插件不受影响。
 */
export const LEGACY_PRESET_CUSTOM_API_URLS = [
  'https://www.tinysignal.fun/soda_music/music_action_v2.php'
];

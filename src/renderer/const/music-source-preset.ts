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
  apiUrl: 'https://www.tinysignal.fun/soda_music/music_action_v2.php',
  method: 'GET',
  params: {
    action: 'getAlgerListenUrl',
    linkMid: '{songId}'
  },
  responseUrlPath: 'data'
} as const;

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.algermusic.app',
  appName: 'Lyra Sphere',
  webDir: 'out/renderer',
  server: {
    androidScheme: 'http',
    cleartext: true
  },
  android: {
    // 音源返回的播放地址多为 http，需要允许混合内容
    allowMixedContent: true
  },
  plugins: {
    // 预置音源接口不带 CORS 头，走原生 HTTP 绕过 WebView 的跨域限制
    CapacitorHttp: {
      enabled: true
    }
  }
};

export default config;

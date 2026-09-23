import axios from 'axios';

const baseURL = `${import.meta.env.VITE_API_MUSIC}`;

/**
 * 是否配了 /music 解析代理。
 *
 * 这个地址只由构建时的 VITE_API_MUSIC 提供，代码里没有任何兜底常量：本地 .env.development
 * 里是占位符 `***`，生产要靠 CI 注入。没配时上面的 baseURL 会变成字符串 "undefined"，
 * `/music` 拼出来是个相对路径，会被 WebView 当成本地路由、返回一个 200 的 index.html——
 * 既不报错也拿不到 url，只是白白耗掉一次请求。所以调用前先用这个判断兜一下。
 */
export const hasMusicProxy = (): boolean =>
  typeof import.meta.env.VITE_API_MUSIC === 'string' &&
  /^https?:\/\//i.test(import.meta.env.VITE_API_MUSIC);

const request = axios.create({
  baseURL,
  timeout: 10000
});

// 请求拦截器
request.interceptors.request.use(
  (config) => {
    return config;
  },
  (error) => {
    // 当请求异常时做一些处理
    return Promise.reject(error);
  }
);

export default request;

import axios, { InternalAxiosRequestConfig } from 'axios';

import { FALLBACK_NETEASE_API } from '@/const/music-source-preset';
import { useUserStore } from '@/store/modules/user';

import { getSetData, isElectron, isMobile } from '.';

let setData: any = null;

// 扩展请求配置接口
interface CustomAxiosRequestConfig extends InternalAxiosRequestConfig {
  retryCount?: number;
  noRetry?: boolean;
}

/**
 * 去掉用户填的地址末尾的斜杠。
 *
 * 这里返回的地址后面要直接拼 `/song/detail` 这种路径，留着尾斜杠会拼出双斜杠，
 * 有些网关会当成另一条路由直接 404。用户从浏览器地址栏复制过来的地址基本都带尾斜杠。
 */
const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * 用户没配地址时用的默认值，也是设置页输入框的占位提示。
 *
 * VITE_API 只是「一个更好的默认值」，不是锁：用户在设置里填了地址就以他填的为准。
 * 反过来的话，凡是用 VITE_API 构建出来的包，设置里那个输入框都是个摆设——写进去
 * 新地址，请求照旧打到旧地址，比没有这个输入框还糟。
 */
export const DEFAULT_NETEASE_API = stripTrailingSlash(
  import.meta.env.VITE_API || FALLBACK_NETEASE_API
);

const resolveBaseURL = () => {
  if (window.electron) {
    return `http://127.0.0.1:${setData?.musicApiPort}`;
  }
  // 非 Electron 端（Web / Android）没有本地接口服务，只能连远端。
  // setData 由请求拦截器每次请求刷新，所以用户改完地址不用重启就生效。
  const customApiUrl = setData?.neteaseApiUrl?.trim();
  return customApiUrl ? stripTrailingSlash(customApiUrl) : DEFAULT_NETEASE_API;
};

const baseURL = resolveBaseURL();

const request = axios.create({
  baseURL,
  timeout: 15000,
  withCredentials: true
});

// 最大重试次数
const MAX_RETRIES = 1;
// 重试延迟（毫秒）
const RETRY_DELAY = 500;

// 请求拦截器
request.interceptors.request.use(
  (config: CustomAxiosRequestConfig) => {
    setData = getSetData();
    config.baseURL = resolveBaseURL();
    // 只在retryCount未定义时初始化为0
    if (config.retryCount === undefined) {
      config.retryCount = 0;
    }

    // 在请求发送之前做一些处理
    // 在get请求params中添加timestamp
    config.params = {
      ...config.params,
      timestamp: Date.now(),
      device: isElectron ? 'pc' : isMobile ? 'mobile' : 'web'
    };
    const token = localStorage.getItem('token');
    if (token && config.method !== 'post') {
      config.params.cookie = config.params.cookie !== undefined ? config.params.cookie : token;
    } else if (token && config.method === 'post') {
      config.data = {
        ...config.data,
        cookie: token
      };
    }
    if (isElectron) {
      const proxyConfig = setData?.proxyConfig;
      if (proxyConfig?.enable && ['http', 'https'].includes(proxyConfig?.protocol)) {
        config.params.proxy = `${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`;
      }
      if (setData.enableRealIP && setData.realIP) {
        config.params.realIP = setData.realIP;
      }
    }

    return config;
  },
  (error) => {
    // 当请求异常时做一些处理
    return Promise.reject(error);
  }
);

const NO_RETRY_URLS = ['暂时没有'];

// 响应拦截器
request.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    console.error('error', error);
    const config = error.config as CustomAxiosRequestConfig;

    // 如果没有配置，直接返回错误
    if (!config) {
      return Promise.reject(error);
    }

    // 处理 301 状态码
    if (error.response?.status === 301 && config.params.noLogin !== true) {
      // 使用 store mutation 清除用户信息
      const userStore = useUserStore();
      userStore.handleLogout();
      console.log(`301 状态码，清除登录信息后重试第 ${config.retryCount} 次`);
      config.retryCount = 3;
    }

    // 检查是否还可以重试
    if (
      config.retryCount !== undefined &&
      config.retryCount < MAX_RETRIES &&
      !NO_RETRY_URLS.includes(config.url as string) &&
      !config.noRetry
    ) {
      config.retryCount++;
      console.error(`请求重试第 ${config.retryCount} 次`);

      // 延迟重试
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));

      // 重新发起请求
      return request(config);
    }

    console.error(`重试${MAX_RETRIES}次后仍然失败`);
    return Promise.reject(error);
  }
);

export default request;

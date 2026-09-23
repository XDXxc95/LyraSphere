import './index.css';
import '@/assets/css/mobile.css';
import 'animate.css';
import 'remixicon/fonts/remixicon.css';

import { createApp } from 'vue';

import i18n from '@/../i18n/renderer';
import router from '@/router';
import pinia from '@/store';
import { installAppLog } from '@/utils/appLog';
import { watchNativeInsets } from '@/utils/nativeInsets';

import App from './App.vue';
import directives from './directive';

// 最早安装：晚一步就会漏掉启动阶段的输出
installAppLog();

// Android 端页面画在状态栏下面，需要原生给出的真实高度来避让
watchNativeInsets();

const app = createApp(App);

Object.keys(directives).forEach((key: string) => {
  app.directive(key, directives[key as keyof typeof directives]);
});

app.use(pinia);
app.use(router);
app.use(i18n as any);
app.mount('#app');

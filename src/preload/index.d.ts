import { ElectronAPI } from '@electron-toolkit/preload';

import type { AppUpdateState } from '../shared/appUpdate';

interface API {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  quitApp: () => void;
  dragStart: (data: any) => void;
  miniTray: () => void;
  miniWindow: () => void;
  restore: () => void;
  restart: () => void;
  resizeWindow: (width: number, height: number) => void;
  resizeMiniWindow: (showPlaylist: boolean) => void;
  openLyric: () => void;
  sendLyric: (data: any) => void;
  sendSong: (data: any) => void;
  unblockMusic: (id: number, data: any, enabledSources?: string[]) => Promise<any>;
  onLyricWindowClosed: (callback: () => void) => void;
  onLyricWindowReady: (callback: () => void) => void;
  getAppUpdateState: () => Promise<AppUpdateState>;
  checkAppUpdate: (manual?: boolean) => Promise<AppUpdateState>;
  downloadAppUpdate: () => Promise<AppUpdateState>;
  installAppUpdate: () => Promise<boolean>;
  openAppUpdatePage: () => Promise<boolean>;
  onAppUpdateState: (callback: (state: AppUpdateState) => void) => void;
  removeAppUpdateListeners: () => void;
  onLanguageChanged: (callback: (locale: string) => void) => void;
  importCustomApiPlugin: () => Promise<{ name: string; content: string } | null>;
  importLxMusicScript: () => Promise<{ name: string; content: string } | null>;
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  getSearchSuggestions: (keyword: string) => Promise<any>;
  /** 诊断日志：渲染进程 console 转发进主进程的日志文件 */
  diagnosticsLog: (payload: { message: string; level?: string; tag?: string }) => Promise<void>;
  /** 诊断日志文件的位置与大小 */
  diagnosticsInfo: () => Promise<{
    path: string;
    dir: string;
    sizeBytes: number;
    exists: boolean;
  }>;
  diagnosticsClear: () => Promise<void>;
  diagnosticsExport: () => Promise<{ path: string; sizeBytes: number; supported: boolean }>;
  diagnosticsOpenFolder: () => Promise<{ opened: boolean; path: string }>;
  diagnosticsShare: () => Promise<{ path: string }>;
  lxMusicHttpRequest: (request: { url: string; options: any; requestId: string }) => Promise<any>;
  lxMusicHttpCancel: (requestId: string) => Promise<void>;
  /** 扫描指定文件夹中的本地音乐文件 */
  scanLocalMusic: (folderPath: string) => Promise<{ files: string[]; count: number }>;
  /** 扫描指定文件夹中的本地音乐文件（包含修改时间） */
  scanLocalMusicWithStats: (
    folderPath: string
  ) => Promise<{ files: { path: string; modifiedTime: number }[]; count: number }>;
  /** 批量解析本地音乐文件元数据 */
  parseLocalMusicMetadata: (
    filePaths: string[]
  ) => Promise<import('../renderer/types/localMusic').LocalMusicMeta[]>;
}

// 自定义IPC渲染进程通信接口
interface IpcRenderer {
  send: (channel: string, ...args: any[]) => void;
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  on: (channel: string, listener: (...args: any[]) => void) => () => void;
  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    api: API;
    ipcRenderer: IpcRenderer;
    $message: any;
  }
}

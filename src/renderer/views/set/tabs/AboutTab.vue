<template>
  <setting-section :title="t('settings.sections.about')">
    <setting-item :title="t('settings.about.version')">
      <template #description>
        <div class="flex flex-wrap items-center gap-2">
          <span>{{ updateInfo.currentVersion }}</span>
          <n-tag v-if="updateInfo.hasUpdate" type="success">
            {{ t('settings.about.hasUpdate') }} {{ updateInfo.latestVersion }}
          </n-tag>
        </div>
        <div v-if="hasManualUpdateFallback" class="mt-2 text-xs text-amber-600">
          <i class="ri-information-line mr-1"></i>
          {{ appUpdateState.errorMessage || t('settings.about.messages.checkError') }}
        </div>
      </template>
      <template #action>
        <div class="flex items-center gap-2 flex-wrap">
          <s-btn :loading="checking" @click="checkForUpdates(true)">
            {{ checking ? t('settings.about.checking') : t('settings.about.checkUpdate') }}
          </s-btn>
          <s-btn v-if="updateInfo.hasUpdate" variant="primary" @click="openReleasePage">
            {{ t('settings.about.gotoUpdate') }}
          </s-btn>
          <s-btn v-if="hasManualUpdateFallback" variant="ghost" @click="openManualUpdatePage">
            {{ t('settings.about.manualUpdate') }}
          </s-btn>
        </div>
      </template>
    </setting-item>

    <setting-item
      :title="t('settings.about.author')"
      :description="t('settings.about.authorDesc')"
      clickable
      @click="openAuthor"
    >
      <s-btn @click.stop="openAuthor">
        <i class="ri-github-line mr-1"></i>{{ t('settings.about.gotoGithub') }}
      </s-btn>
    </setting-item>
  </setting-section>

  <!-- 排障用：原生端和桌面端各有一套出口（见 utils/appLog.ts），浏览器里不出现 -->
  <setting-section v-if="logAvailable" :title="t('settings.about.log.title')">
    <setting-item :title="t('settings.about.log.file')">
      <template #description>
        <span>
          {{
            t(logIsDesktop ? 'settings.about.log.fileDescDesktop' : 'settings.about.log.fileDesc')
          }}
        </span>
        <div v-if="logInfo" class="mt-1 text-xs font-mono break-all opacity-70">
          {{ logInfo.path }}（{{ formatSize(logInfo.sizeBytes) }}）
        </div>
      </template>
      <template #action>
        <div class="flex items-center gap-2 flex-wrap">
          <s-btn :loading="opening" @click="handleOpenLogFolder">
            <i class="ri-folder-open-line mr-1"></i>
            {{
              t(
                logIsDesktop
                  ? 'settings.about.log.openFolderDesktop'
                  : 'settings.about.log.openFolder'
              )
            }}
          </s-btn>
          <!-- 桌面没有系统分享面板，改成显式的「导出到下载目录」 -->
          <s-btn v-if="logIsDesktop" :loading="exporting" variant="ghost" @click="handleExportLog">
            <i class="ri-download-2-line mr-1"></i>{{ t('settings.about.log.exportDesktop') }}
          </s-btn>
          <s-btn v-else variant="ghost" @click="handleShareLog">
            <i class="ri-share-line mr-1"></i>{{ t('settings.about.log.share') }}
          </s-btn>
        </div>
      </template>
    </setting-item>

    <setting-item
      :title="t('settings.about.log.clear')"
      :description="t('settings.about.log.clearDesc')"
    >
      <template #action>
        <s-btn variant="danger" @click="handleClearLog">
          <i class="ri-delete-bin-line mr-1"></i>{{ t('settings.about.log.clear') }}
        </s-btn>
      </template>
    </setting-item>
  </setting-section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { useSettingsStore } from '@/store/modules/settings';
import { isElectron } from '@/utils';
import {
  clearAppLog,
  exportAppLog,
  getLogInfo,
  isAppLogAvailable,
  LogInfo,
  openAppLogFolder,
  shareAppLog
} from '@/utils/appLog';
import { checkUpdate, UpdateResult } from '@/utils/update';

import config from '../../../../../package.json';
import { APP_UPDATE_STATUS, hasAvailableAppUpdate } from '../../../../shared/appUpdate';
import { SETTINGS_DATA_KEY, SETTINGS_MESSAGE_KEY } from '../keys';
import SBtn from '../SBtn.vue';
import SettingItem from '../SettingItem.vue';
import SettingSection from '../SettingSection.vue';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const setData = inject(SETTINGS_DATA_KEY)!;
const message = inject(SETTINGS_MESSAGE_KEY)!;

const checking = ref(false);
const webUpdateInfo = ref<UpdateResult>({
  hasUpdate: false,
  latestVersion: '',
  currentVersion: config.version,
  releaseInfo: null
});

const appUpdateState = computed(() => settingsStore.appUpdateState);
const hasAppUpdate = computed(() => hasAvailableAppUpdate(appUpdateState.value));
const hasManualUpdateFallback = computed(
  () => isElectron && appUpdateState.value.status === APP_UPDATE_STATUS.error
);

const updateInfo = computed<UpdateResult>(() => {
  if (!isElectron) {
    return webUpdateInfo.value;
  }

  return {
    hasUpdate: hasAppUpdate.value,
    latestVersion: appUpdateState.value.availableVersion ?? '',
    currentVersion: appUpdateState.value.currentVersion || config.version,
    releaseInfo: appUpdateState.value.availableVersion
      ? {
          tag_name: appUpdateState.value.availableVersion,
          body: appUpdateState.value.releaseNotes,
          html_url: appUpdateState.value.releasePageUrl,
          assets: []
        }
      : null
  };
});

const checkForUpdates = async (isClick = false) => {
  checking.value = true;
  try {
    if (isElectron) {
      const result = await window.api.checkAppUpdate(isClick);
      settingsStore.setAppUpdateState(result);

      if (hasAvailableAppUpdate(result)) {
        if (isClick) {
          settingsStore.setShowUpdateModal(true);
        }
      } else if (result.status === APP_UPDATE_STATUS.notAvailable && isClick) {
        message.success(t('settings.about.latest'));
      } else if (result.status === APP_UPDATE_STATUS.error && isClick) {
        message.error(result.errorMessage || t('settings.about.messages.checkError'));
      }

      return;
    }

    const result = await checkUpdate(config.version);
    if (result) {
      webUpdateInfo.value = result;
      if (!result.hasUpdate && isClick) {
        message.success(t('settings.about.latest'));
      }
    } else if (isClick) {
      message.success(t('settings.about.latest'));
    }
  } catch (error) {
    console.error('检查更新失败:', error);
    if (isClick) {
      message.error(t('settings.about.messages.checkError'));
    }
  } finally {
    checking.value = false;
  }
};

const openReleasePage = () => {
  if (isElectron) {
    settingsStore.setShowUpdateModal(true);
    return;
  }

  window.open(updateInfo.value.releaseInfo?.html_url || setData.value.authorUrl);
};

const openManualUpdatePage = async () => {
  if (isElectron) {
    await window.api.openAppUpdatePage();
    return;
  }

  window.open(updateInfo.value.releaseInfo?.html_url || setData.value.authorUrl);
};

const openAuthor = () => {
  window.open(setData.value.authorUrl);
};

// ==================== 诊断日志 ====================

const logAvailable = isAppLogAvailable;
/** 桌面端和原生端的出口不同，文案与退路都要分开（见 utils/appLog.ts） */
const logIsDesktop = isElectron;
const logInfo = ref<LogInfo | null>(null);
const opening = ref(false);
const exporting = ref(false);

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const refreshLogInfo = async () => {
  logInfo.value = await getLogInfo();
};

const handleOpenLogFolder = async () => {
  opening.value = true;
  try {
    const result = await openAppLogFolder();
    if (result.opened) {
      message.success(
        t(logIsDesktop ? 'settings.about.log.openedDesktop' : 'settings.about.log.opened', {
          path: result.path
        })
      );
    } else {
      message.warning(
        t(logIsDesktop ? 'settings.about.log.openFailedDesktop' : 'settings.about.log.openFailed', {
          path: result.path
        })
      );
      // 原生端有些文件管理器不认「打开目录」这个 Intent，退回分享面板，
      // 用户照样能把文件发出来（发到微信/邮件/保存到文件都行）；
      // 桌面端的 open-folder 内部已经退到「导出并在资源管理器里定位」，不必再补一刀
      if (!logIsDesktop) await shareAppLog();
    }
    await refreshLogInfo();
  } catch (error) {
    console.error('打开日志目录失败:', error);
    message.error(t('settings.about.log.openFailed', { path: '' }));
  } finally {
    opening.value = false;
  }
};

const handleExportLog = async () => {
  exporting.value = true;
  try {
    const result = await exportAppLog();
    if (result) {
      message.success(t('settings.about.log.exported', { path: result.path }));
    } else {
      message.error(t('settings.about.log.exportFailed'));
    }
    await refreshLogInfo();
  } catch (error) {
    console.error('导出日志失败:', error);
    message.error(t('settings.about.log.exportFailed'));
  } finally {
    exporting.value = false;
  }
};

const handleShareLog = async () => {
  try {
    await shareAppLog();
  } catch (error) {
    console.error('分享日志失败:', error);
    message.error(t('settings.about.log.shareFailed'));
  }
};

const handleClearLog = async () => {
  try {
    await clearAppLog();
    await refreshLogInfo();
    message.success(t('settings.about.log.cleared'));
  } catch (error) {
    console.error('清空日志失败:', error);
  }
};

onMounted(refreshLogInfo);

defineExpose({ checkForUpdates });
</script>

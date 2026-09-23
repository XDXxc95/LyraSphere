package com.algermusic.app;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 极简文件日志。
 *
 * 存在的意义是排障：WebView 里的播放链路（howler / 音频焦点 / 原生服务）一旦出问题，
 * 光靠眼睛看不出是哪一段断的，而本机 adb 又不可用。所以把关键状态落到一个文件里，
 * 用户在设置页一键导出即可。
 *
 * 同时镜像一份到 logcat，便于有 adb 的时候照常看。
 * 日志写在应用私有外部目录（/sdcard/Android/data/<包名>/files/logs/），
 * 不需要任何存储权限；导出到公共目录由 {@link DiagnosticsPlugin} 负责。
 */
public final class AppLog {

    public static final String TAG = "AlgerMusic";

    private static final String DIR_NAME = "logs";
    private static final String FILE_NAME = "alger.log";
    /** 单文件上限，超了就轮转出一份 .1 备份，避免长期运行把存储写满 */
    private static final long MAX_BYTES = 2L * 1024 * 1024;

    private static final Object LOCK = new Object();
    private static final SimpleDateFormat TIME =
            new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US);

    private static File logFile;

    private AppLog() {}

    /** 幂等；拿不到目录时返回 null，后续写入静默丢弃 */
    public static File init(Context context) {
        synchronized (LOCK) {
            if (logFile != null) return logFile;

            File base = context.getExternalFilesDir(null);
            if (base == null) base = context.getFilesDir();

            File dir = new File(base, DIR_NAME);
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "日志目录创建失败: " + dir);
                return null;
            }

            logFile = new File(dir, FILE_NAME);
            appendHeader(context);
            return logFile;
        }
    }

    public static File getFile() {
        synchronized (LOCK) {
            return logFile;
        }
    }

    public static void log(String tag, String message) {
        write("I", tag, message);
    }

    public static void warn(String tag, String message) {
        write("W", tag, message);
    }

    public static void error(String tag, String message) {
        write("E", tag, message);
    }

    /**
     * 写一行。异常一律吞掉——日志本身不该成为新的崩溃源。
     */
    public static void write(String level, String tag, String message) {
        if ("E".equals(level)) {
            Log.e(TAG, tag + ": " + message);
        } else if ("W".equals(level)) {
            Log.w(TAG, tag + ": " + message);
        } else {
            Log.i(TAG, tag + ": " + message);
        }

        synchronized (LOCK) {
            if (logFile == null) return;

            rotateIfNeeded();

            String line;
            synchronized (TIME) {
                line = TIME.format(new Date()) + " " + level + "/" + tag + ": " + message + "\n";
            }

            try (Writer writer = new OutputStreamWriter(
                    new FileOutputStream(logFile, true), StandardCharsets.UTF_8)) {
                writer.write(line);
            } catch (IOException e) {
                Log.w(TAG, "写日志失败: " + e.getMessage());
            }
        }
    }

    public static void clear() {
        synchronized (LOCK) {
            if (logFile != null && logFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                logFile.delete();
            }
        }
    }

    private static void rotateIfNeeded() {
        if (!logFile.exists() || logFile.length() < MAX_BYTES) return;

        File backup = new File(logFile.getParentFile(), FILE_NAME + ".1");
        //noinspection ResultOfMethodCallIgnored
        backup.delete();
        //noinspection ResultOfMethodCallIgnored
        logFile.renameTo(backup);
    }

    /** 每次冷启动插一段设备信息，方便判断日志是哪个版本、哪台机器跑的 */
    private static void appendHeader(Context context) {
        StringBuilder header = new StringBuilder();
        header.append("\n========== 会话开始 ==========\n");
        header.append("App: ").append(context.getPackageName()).append('\n');
        header.append("Android: ").append(Build.VERSION.RELEASE)
                .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
        header.append("Device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');

        synchronized (TIME) {
            header.append("Time: ").append(TIME.format(new Date())).append('\n');
        }

        try (Writer writer = new OutputStreamWriter(
                new FileOutputStream(logFile, true), StandardCharsets.UTF_8)) {
            writer.write(header.toString());
        } catch (IOException e) {
            Log.w(TAG, "写日志头失败: " + e.getMessage());
        }
    }
}

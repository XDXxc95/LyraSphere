package com.algermusic.app;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 排障用：把 {@link AppLog} 写到文件，并让用户能把文件从设备里拿出来。
 *
 * 三条出路，按可靠性排序：
 * 1. {@link #openLogFolder} —— 先导出到公共 Download，再尝试用文件管理器打开该目录；
 * 2. {@link #shareLog} —— 系统分享面板，跨版本最可靠，可分享到微信/邮件/保存到文件；
 * 3. 前端界面上直接显示绝对路径，用户手动去找。
 *
 * 之所以不直接写公共目录：Android 10 起分区存储下应用无法随意写 /sdcard，
 * 而持续写 MediaStore 的开销也不划算。所以平时写在应用私有外部目录（免权限），
 * 用户点导出时才复制一份到 Download。
 */
@CapacitorPlugin(name = "Diagnostics")
public class DiagnosticsPlugin extends Plugin {

    /** 导出到 Download 下的子目录名 */
    private static final String EXPORT_DIR = "AlgerMusicPlayer";

    @Override
    public void load() {
        AppLog.init(getContext().getApplicationContext());
    }

    /**
     * 前端 console 转发进来的日志。
     * 前端会攒一批用 \n 拼起来发，这里拆开逐行写，保证每行都有自己的时间戳。
     */
    @PluginMethod
    public void log(PluginCall call) {
        String message = call.getString("message", "");
        String level = call.getString("level", "I");
        String tag = call.getString("tag", "WebView");
        if (message.isEmpty()) {
            call.resolve();
            return;
        }

        for (String line : message.split("\n")) {
            if (!line.isEmpty()) {
                AppLog.write(level, tag, line);
            }
        }
        call.resolve();
    }

    /** 当前日志文件的位置与大小，用来在界面上显示 */
    @PluginMethod
    public void info(PluginCall call) {
        File file = AppLog.getFile();
        JSObject result = new JSObject();
        result.put("path", file == null ? "" : file.getAbsolutePath());
        result.put("dir", file == null ? "" : file.getParent());
        result.put("sizeBytes", file != null && file.exists() ? file.length() : 0);
        result.put("exists", file != null && file.exists());
        call.resolve(result);
    }

    @PluginMethod
    public void clearLog(PluginCall call) {
        AppLog.clear();
        AppLog.log("Diagnostics", "日志已清空");
        call.resolve();
    }

    /**
     * 导出到公共 Download 目录。
     * Android 10+ 走 MediaStore，不需要任何存储权限；
     * 更低版本没有分区存储，退回分享面板即可，这里直接报不支持。
     */
    @PluginMethod
    public void exportLog(PluginCall call) {
        JSObject result = new JSObject();
        File source = AppLog.getFile();

        if (source == null || !source.exists()) {
            call.reject("日志文件还不存在");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // 老系统写公共目录需要 WRITE_EXTERNAL_STORAGE，这里不去申请了，直接让前端走分享
            call.reject("Android 10 以下请使用分享方式导出");
            return;
        }

        try {
            Uri uri = copyToDownloads(source);
            result.put("uri", uri.toString());
            result.put("path", EXPORT_DIR + "/" + displayName(source));
            result.put("sizeBytes", source.length());
            result.put("supported", true);
            call.resolve(result);
        } catch (Exception e) {
            AppLog.error("Diagnostics", "导出日志失败: " + e.getMessage());
            call.reject("导出失败: " + e.getMessage());
        }
    }

    /**
     * 导出后尝试用文件管理器打开所在目录。
     * Android 上「打开一个目录」没有官方统一入口，各家文件管理器对 DocumentsUI 的
     * dir 类型 URI 支持不一，所以这里探测不到就返回 opened=false，前端退回分享。
     */
    @PluginMethod
    public void openLogFolder(PluginCall call) {
        JSObject result = new JSObject();

        File source = AppLog.getFile();
        if (source == null || !source.exists()) {
            call.reject("日志文件还不存在");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            result.put("opened", false);
            result.put("path", source.getAbsolutePath());
            call.resolve(result);
            return;
        }

        try {
            copyToDownloads(source);

            Uri folder = Uri.parse("content://com.android.externalstorage.documents/document/primary%3A"
                    + Environment.DIRECTORY_DOWNLOADS + "%2F" + EXPORT_DIR);

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(folder, "vnd.android.document/directory");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_ACTIVITY_NEW_TASK);

            Context context = getContext();
            if (intent.resolveActivity(context.getPackageManager()) == null) {
                result.put("opened", false);
                result.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR);
                call.resolve(result);
                return;
            }

            context.startActivity(intent);
            result.put("opened", true);
            result.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR);
            call.resolve(result);
        } catch (Exception e) {
            AppLog.warn("Diagnostics", "打开日志目录失败: " + e.getMessage());
            result.put("opened", false);
            result.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR);
            call.resolve(result);
        }
    }

    /** 系统分享面板，把日志文件发出去 */
    @PluginMethod
    public void shareLog(PluginCall call) {
        File source = AppLog.getFile();
        if (source == null || !source.exists()) {
            call.reject("日志文件还不存在");
            return;
        }

        try {
            Context context = getContext();
            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // 导出过的公共文件直接用 MediaStore 的 content URI，WebView 之外都能读
                uri = copyToDownloads(source);
            } else {
                uri = FileProvider.getUriForFile(
                        context, context.getPackageName() + ".fileprovider", source);
            }

            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, "AlgerMusicPlayer 诊断日志");
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(send, "导出日志");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(chooser);

            call.resolve();
        } catch (Exception e) {
            AppLog.error("Diagnostics", "分享日志失败: " + e.getMessage());
            call.reject("分享失败: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- 内部

    private String displayName(File source) {
        // 带上时间戳，多次导出不会互相覆盖
        return source.getName().replace(".log", "-" + System.currentTimeMillis() + ".log");
    }

    private Uri copyToDownloads(File source) throws IOException {
        Context context = getContext().getApplicationContext();
        String name = displayName(source);

        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
        values.put(MediaStore.Downloads.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR);

        // 同名文件先删掉，否则 insert 会生成 alger-xxx (1).log 这种名字
        context.getContentResolver().delete(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                MediaStore.Downloads.DISPLAY_NAME + " = ?", new String[] { name });

        Uri target = context.getContentResolver()
                .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (target == null) {
            throw new IOException("MediaStore 插入失败");
        }

        try (InputStream in = new FileInputStream(source);
             OutputStream out = context.getContentResolver().openOutputStream(target)) {
            if (out == null) throw new IOException("无法打开输出流");

            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        } catch (IOException e) {
            context.getContentResolver().delete(target, null, null);
            throw e;
        }

        return target;
    }
}

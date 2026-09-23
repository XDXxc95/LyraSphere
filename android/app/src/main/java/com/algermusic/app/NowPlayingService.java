package com.algermusic.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.LruCache;
import android.view.KeyEvent;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 前台服务：把渲染进程（WebView 里的 howler.js）的播放状态映射成系统媒体通知 + MediaSession，
 * 并在原生侧处理音频焦点。
 *
 * 必须放在原生侧的原因：
 * - WebView 不会为页面里正在播放的 <audio> 生成系统媒体通知，那个通知在 Chrome 里是浏览器自己做的 UI；
 * - 音频焦点也属于系统级 API，页面拿不到。
 *
 * 用的是框架自带的 android.media.session.MediaSession + Notification.MediaStyle（API 21+），
 * 不引入 androidx.media 依赖。
 */
public class NowPlayingService extends Service {

    public static final String CHANNEL_ID = "alger_now_playing";
    private static final int NOTIFICATION_ID = 10101;

    /** 通知按钮 / MediaSession 动作 → 前端指令 */
    static final String CTRL_PLAY = "play";
    static final String CTRL_PAUSE = "pause";
    static final String CTRL_NEXT = "next";
    static final String CTRL_PREV = "prev";
    static final String CTRL_STOP = "stop";

    /** 通知按钮的自定义 action（用 getService 而不是 BroadcastReceiver，少一个组件） */
    private static final String ACTION_PREV = "com.algermusic.app.notify.PREV";
    private static final String ACTION_TOGGLE = "com.algermusic.app.notify.TOGGLE";
    private static final String ACTION_NEXT = "com.algermusic.app.notify.NEXT";

    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_ARTIST = "artist";
    private static final String EXTRA_ALBUM = "album";
    private static final String EXTRA_COVER = "cover";
    private static final String EXTRA_DURATION = "duration";
    private static final String EXTRA_POSITION = "position";
    private static final String EXTRA_IS_PLAYING = "isPlaying";

    /** 封面最长边缩到这个尺寸以内再放进通知 */
    private static final int COVER_MAX_SIZE = 512;

    /** 把控制指令回传给前端（由 NowPlayingPlugin 实现） */
    public interface ControlListener {
        void onControl(String action);
    }

    /**
     * 插件进程和 Service 同进程，这里存静态引用即可，不需要 binder。
     * Plugin 的生命周期可能短于 Service（比如 Activity 重建），所以 listener 也要能重新挂上。
     */
    private static ControlListener sControlListener;
    private static NowPlayingService sInstance;

    public static void setControlListener(ControlListener listener) {
        sControlListener = listener;
    }

    /**
     * 只有「当前挂着的确实是自己」时才摘掉。
     *
     * Activity 重建时事件顺序看起来是「旧插件 handleOnDestroy → 新插件 load」，无条件置空也
     * 不会错。但 Bridge 的重建和 Activity 的销毁并不严格串行，一旦旧插件的 handleOnDestroy
     * 落在新插件 load 之后，无条件置空就会把刚挂上的 listener 连根拔掉：此后通知栏 / 锁屏 /
     * 耳机按键发来的指令全部走到 {@code (无监听者，丢弃)}，直到下一次 Activity 重建才恢复。
     * 用户看到的就是「按了没反应，点进 app 才好」。
     */
    public static void clearControlListener(ControlListener listener) {
        if (sControlListener == listener) {
            sControlListener = null;
        }
    }

    public static NowPlayingService getInstance() {
        return sInstance;
    }

    /** 服务还没起来时用它启动（必须是「已经在播放」的场景，否则前台服务类型校验不过） */
    static void start(Context context, Update update) {
        Intent intent = new Intent(context, NowPlayingService.class);
        update.writeTo(intent);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /** 一次状态同步的载荷。时长与位置统一用秒，前端负责从毫秒换算。 */
    static class Update {
        String title = "";
        String artist = "";
        String album = "";
        String cover = "";
        double duration = 0d;
        double position = 0d;
        boolean isPlaying = false;

        void writeTo(Intent intent) {
            intent.putExtra(EXTRA_TITLE, title);
            intent.putExtra(EXTRA_ARTIST, artist);
            intent.putExtra(EXTRA_ALBUM, album);
            intent.putExtra(EXTRA_COVER, cover);
            intent.putExtra(EXTRA_DURATION, duration);
            intent.putExtra(EXTRA_POSITION, position);
            intent.putExtra(EXTRA_IS_PLAYING, isPlaying);
        }

        /** 通知按钮触发的 Intent 不带任何 extra，返回 null 表示「沿用当前状态」 */
        static Update from(Intent intent) {
            if (intent == null || !intent.hasExtra(EXTRA_POSITION)) return null;
            Update update = new Update();
            update.title = string(intent, EXTRA_TITLE);
            update.artist = string(intent, EXTRA_ARTIST);
            update.album = string(intent, EXTRA_ALBUM);
            update.cover = string(intent, EXTRA_COVER);
            update.duration = intent.getDoubleExtra(EXTRA_DURATION, 0d);
            update.position = intent.getDoubleExtra(EXTRA_POSITION, 0d);
            update.isPlaying = intent.getBooleanExtra(EXTRA_IS_PLAYING, false);
            return update;
        }

        private static String string(Intent intent, String key) {
            String value = intent.getStringExtra(key);
            return value == null ? "" : value;
        }
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService coverExecutor = Executors.newSingleThreadExecutor();
    private final LruCache<String, Bitmap> coverCache = new LruCache<>(8);

    private MediaSession mediaSession;

    private String title = "";
    private String artist = "";
    private String album = "";
    private String coverUrl = "";
    private Bitmap coverBitmap;
    /** 封面拿不到时兜底的那张图，只渲染一次 */
    private Bitmap fallbackIconBitmap;
    private long durationMs = 0L;
    private long positionMs = 0L;
    private boolean playing = false;

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        AppLog.init(getApplicationContext());
        AppLog.log("NowPlaying", "服务创建");

        createNotificationChannel();

        mediaSession = new MediaSession(this, "AlgerMusicPlayer");
        mediaSession.setCallback(sessionCallback, mainHandler);
        mediaSession.setSessionActivity(buildContentIntent());
        mediaSession.setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        // 先激活 MediaSession，再 startForeground：Android 14+ 要求 mediaPlayback 类型的
        // 前台服务启动时确实在处理媒体
        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (action != null) {
                AppLog.log("NowPlaying", "onStartCommand action=" + action);
            }
            if (ACTION_PREV.equals(action)) {
                dispatchControl(CTRL_PREV);
            } else if (ACTION_NEXT.equals(action)) {
                dispatchControl(CTRL_NEXT);
            } else if (ACTION_TOGGLE.equals(action)) {
                dispatchControl(playing ? CTRL_PAUSE : CTRL_PLAY);
            }

            Update update = Update.from(intent);
            if (update != null) {
                applyNow(update);
            }
        }

        // 必须在很短时间内进入前台态，否则 Android 会抛
        // ForegroundServiceDidNotStartInTimeException
        startForegroundCompat();
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        coverExecutor.shutdownNow();
        sInstance = null;
        super.onDestroy();
    }

    /**
     * 用户从最近任务里把应用划掉了。
     *
     * WebView 挂在 Activity 的视图树上，任务被移除时它已经跟着没了，音频自然也没了；
     * 但前台服务和 MediaSession 会原地活下来，通知栏于是继续挂着一个「看起来能控制、
     * 实际按了没任何反应」的僵尸会话——耳机按键下发到这里，listener 已经是空的，
     * 指令被静默丢弃，用户只能点进 app 重建 Activity 才能恢复。
     * 与其装作还能控制，不如如实收摊：移除通知、释放会话。
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        AppLog.log("NowPlaying", "任务被移除，停止媒体会话");
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    /** 插件线程调进来的入口，统一切回主线程执行 */
    void apply(Update update) {
        mainHandler.post(() -> applyNow(update));
    }

    /** 只切换播放态，元数据不动（播放/暂停时走这条，避免重新下载封面） */
    void setPlaying(boolean value) {
        AppLog.log("NowPlaying", "setPlaying(" + value + ")");
        mainHandler.post(() -> {
            markPlaying(value);
            updateSession();
            refreshNotification();
        });
    }

    /** 停止服务并移除通知 */
    void shutdown() {
        mainHandler.post(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.cancel(NOTIFICATION_ID);
            }
            stopSelf();
        });
    }

    private void applyNow(Update update) {
        title = update.title;
        artist = update.artist;
        album = update.album;
        durationMs = (long) (update.duration * 1000d);
        positionMs = (long) (update.position * 1000d);

        if (!update.cover.equals(coverUrl)) {
            coverUrl = update.cover;
            coverBitmap = coverCache.get(coverUrl);
            if (coverBitmap == null) {
                loadCover(coverUrl);
            }
        }

        AppLog.log("NowPlaying", "收到同步: playing=" + update.isPlaying
                + " pos=" + (long) (update.position * 1000) + "ms"
                + " dur=" + (long) (update.duration * 1000) + "ms"
                + (update.title.isEmpty() ? "" : " title=" + update.title)
                // 封面地址是空的说明渲染进程没给图（picUrl 缺字段 / 本地歌），
                // 和「给了地址但下不下来」是两回事，日志里必须能分开
                + " cover=" + (update.cover.isEmpty() ? "(空)" : update.cover));

        markPlaying(update.isPlaying);
        updateSession();
        refreshNotification();
    }

    private void markPlaying(boolean value) {
        boolean wasPlaying = playing;
        playing = value;
        if (value != wasPlaying) {
            AppLog.log("NowPlaying", "播放态: " + wasPlaying + " -> " + value);
        }
    }

    // ---------------------------------------------------------------- 音频焦点
    //
    // 这个服务**刻意不申请音频焦点**，别再加回来。
    //
    // 曾经这里有一整套 AudioFocusRequest + OnAudioFocusChangeListener：收到渲染进程
    // 的 playing=true 就抢焦点，拿到 LOSS 就下发暂停。真机上表现为「点播放响一下
    // 就停」，日志里是每次必现的固定套路：
    //
    //     申请焦点 -> GRANTED
    //     <audio> play / playing            (~0.1s 后声音出来)
    //     焦点变化: LOSS                    (~200ms 后)
    //     下发控制指令: pause               ← 自己把自己掐了
    //
    // 抢焦点的不是「别的播放器」，是我们自己 WebView 里的 <audio>：
    // 渲染进程先把 playing=true 同步过来（此时音频还没开始播），服务抢先拿到焦点；
    // 紧接着 Chromium 为真正发声的媒体元素申请焦点，把焦点从我们手里拿走，
    // 于是我们的 listener 收到 LOSS，乖乖暂停了自己。
    //
    // 同一个进程里两个焦点客户端必然互抢，而 Android 不提供任何手段让 listener
    // 分辨「抢我的是别的应用」还是「抢我的是自家 WebView」。真正发声的是 Chromium
    // 的媒体元素，焦点本来就该由它来管——来电、导航播报这些打断它都会自己处理，
    // 打断与恢复会如实体现在 <audio> 的 pause / play 事件上，由渲染进程的
    // mediaElementProbe 同步回 store 和通知栏。

    // ---------------------------------------------------------------- MediaSession

    private final MediaSession.Callback sessionCallback = new MediaSession.Callback() {

        /**
         * 把原始按键码记下来。
         *
         * 基类默认实现会把 KEYCODE_HEADSETHOOK 这类按键翻译成 onPlay / onPause 再回调过来，
         * 翻译过程是看不见的。真机日志里出现过「从暂停状态连按七次，收到的全是 pause」，
         * 只有 raw keyCode 能区分是耳机本身只发 PAUSE，还是 ROM 把 HEADSETHOOK 一律翻成了
         * PAUSE——两者的处理不一样，得先看清楚。
         */
        @Override
        public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
            if (mediaButtonIntent != null) {
                KeyEvent event = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                    AppLog.log("NowPlaying", "媒体按键: keyCode=" + event.getKeyCode());
                }
            }
            return super.onMediaButtonEvent(mediaButtonIntent);
        }

        @Override
        public void onPlay() {
            dispatchControl(CTRL_PLAY);
        }

        @Override
        public void onPause() {
            dispatchControl(CTRL_PAUSE);
        }

        @Override
        public void onStop() {
            dispatchControl(CTRL_STOP);
        }

        @Override
        public void onSkipToNext() {
            dispatchControl(CTRL_NEXT);
        }

        @Override
        public void onSkipToPrevious() {
            dispatchControl(CTRL_PREV);
        }
    };

    private void dispatchControl(String action) {
        ControlListener listener = sControlListener;
        AppLog.log("NowPlaying", "下发控制指令: " + action + (listener == null ? " (无监听者，丢弃)" : ""));
        if (listener != null) {
            listener.onControl(action);
        }
    }

    private void updateSession() {
        if (mediaSession == null) return;

        // 媒体按键只会派给「活跃」的会话。会话长时间不可见之后被系统摘掉活跃态的话，
        // 耳机按键就再也送不到这里了，而重启 App 之前没有任何东西会把它重新激活。
        // 每次刷新状态时顺手重申一次；本来就活跃时这是个空操作。
        mediaSession.setActive(true);

        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        Bitmap artwork = coverBitmap != null ? coverBitmap : fallbackIcon();
        if (artwork != null) {
            // ALBUM_ART 是「专辑封面」那个语义槽，ART 是「这一条媒体」的图。系统媒体卡片在
            // 不同版本上读的键不一样（有的只认 ART，有的只认 ALBUM_ART），两个都放最保险。
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ART, artwork);
        }
        mediaSession.setMetadata(metadata.build());

        PlaybackState.Builder state = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY
                        | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        positionMs,
                        playing ? 1.0f : 0f);
        mediaSession.setPlaybackState(state.build());
    }

    // ---------------------------------------------------------------- 通知

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_now_playing),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notification_channel_now_playing_desc));
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void startForegroundCompat() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void refreshNotification() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        builder.setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(title.isEmpty() ? getString(R.string.app_name) : title)
                .setContentText(artist)
                .setContentIntent(buildContentIntent())
                // 锁屏上可见
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                // 播放时通知不可手动划掉；暂停后允许划走
                .setOngoing(playing)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,
                        getString(R.string.notification_action_prev),
                        buildActionIntent(ACTION_PREV)).build())
                .addAction(new Notification.Action.Builder(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        getString(playing
                                ? R.string.notification_action_pause
                                : R.string.notification_action_play),
                        buildActionIntent(ACTION_TOGGLE)).build())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,
                        getString(R.string.notification_action_next),
                        buildActionIntent(ACTION_NEXT)).build());

        // 媒体卡片上那块图就是从这里的 large icon 取的。封面没下下来时退到应用图标，
        // 不让它空着——空着看起来就是「这个 app 坏了」，而不是「封面暂时没拿到」。
        Bitmap largeIcon = coverBitmap != null ? coverBitmap : fallbackIcon();
        if (largeIcon != null) {
            builder.setLargeIcon(largeIcon);
        }

        Notification.MediaStyle style = new Notification.MediaStyle()
                .setShowActionsInCompactView(0, 1, 2);
        if (mediaSession != null) {
            style.setMediaSession(mediaSession.getSessionToken());
        }
        builder.setStyle(style);

        return builder.build();
    }

    private PendingIntent buildActionIntent(String action) {
        Intent intent = new Intent(this, NowPlayingService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent buildContentIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ---------------------------------------------------------------- 封面

    /**
     * 应用图标，封面缺席时拿它顶上。
     *
     * 刻意不用 {@code BitmapFactory.decodeResource(R.mipmap.ic_launcher)}：API 26+ 上这个
     * 资源解析到的是 mipmap-anydpi-v26 里的自适应图标 XML，decodeResource 对 XML 返回 null，
     * 兜底本身就失效了。getApplicationIcon 拿到的是已经组装好的 Drawable，画到 Bitmap 上
     * 各个版本都对。
     */
    private Bitmap fallbackIcon() {
        if (fallbackIconBitmap != null) return fallbackIconBitmap;

        try {
            Drawable drawable = getPackageManager().getApplicationIcon(getPackageName());
            int size = getResources().getDimensionPixelSize(android.R.dimen.app_icon_size);
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(canvas);
            fallbackIconBitmap = bitmap;
        } catch (Exception e) {
            AppLog.warn("NowPlaying", "读取应用图标失败: " + e);
        }
        return fallbackIconBitmap;
    }

    private void loadCover(String url) {
        if (url.isEmpty()) return;
        coverExecutor.execute(() -> {
            Bitmap bitmap = downloadCover(url);
            if (bitmap == null) {
                // 原地址没取到，换个协议再试一次。接口给回来的封面 http / https / `//`
                // 开头都有，猜错一个就整张图没了，多试一次的成本很低。
                String alternate = alternateCoverUrl(url);
                if (alternate != null) {
                    AppLog.warn("NowPlaying", "封面原地址取不到，改试: " + alternate);
                    bitmap = downloadCover(alternate);
                }
            }
            if (bitmap == null) {
                AppLog.warn("NowPlaying", "封面最终没取到，媒体卡片退回应用图标: " + url);
                return;
            }
            AppLog.log("NowPlaying", "封面就绪 " + bitmap.getWidth() + "x" + bitmap.getHeight());
            coverCache.put(url, bitmap);
            final Bitmap loaded = bitmap;
            mainHandler.post(() -> {
                // 期间可能已经换歌了
                if (url.equals(coverUrl)) {
                    coverBitmap = loaded;
                    updateSession();
                    refreshNotification();
                }
            });
        });
    }

    /**
     * 换一个协议再试：`//host/x.jpg` → `https://...`，http ↔ https 互换。
     * 没有可换的（比如 relative 路径、data URL）返回 null。
     */
    private static String alternateCoverUrl(String url) {
        if (url.startsWith("//")) return "https:" + url;
        if (url.startsWith("https://")) return "http://" + url.substring("https://".length());
        if (url.startsWith("http://")) return "https://" + url.substring("http://".length());
        return null;
    }

    private Bitmap downloadCover(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) AlgerMusicPlayer");
            int code = connection.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                AppLog.warn("NowPlaying", "封面 HTTP " + code + ": " + url);
                return null;
            }

            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            try (InputStream input = connection.getInputStream()) {
                int read;
                while ((read = input.read(chunk)) > 0) {
                    buffer.write(chunk, 0, read);
                }
            }
            byte[] data = buffer.toByteArray();

            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, probe);
            if (probe.outWidth <= 0 || probe.outHeight <= 0) {
                // 拿到的不是图片（验证页、错误 JSON……），日志里带上长度便于分辨
                AppLog.warn("NowPlaying", "封面解不出尺寸，收到 " + data.length + " 字节: " + url);
                return null;
            }

            int longest = Math.max(probe.outWidth, probe.outHeight);
            int sampleSize = 1;
            while (longest / sampleSize > COVER_MAX_SIZE) {
                sampleSize *= 2;
            }

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sampleSize;
            return BitmapFactory.decodeByteArray(data, 0, data.length, options);
        } catch (Exception e) {
            // 封面拿不到也不影响播放，只是通知栏没图；但原因要落到日志里，
            // 否则「媒体卡片是空的」这种问题只能靠猜
            AppLog.warn("NowPlaying", "封面下载异常 " + e + ": " + url);
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }
}

package com.personal.vsu.schedule;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ClassTimerService extends Service {
    private static final String TAG = "ClassTimerService";

    public static final String CHANNEL_SERVICE = "vsu_class_timer_service";
    public static final String CHANNEL_ISLAND = "vsu_class_timer_island";

    public static final int SERVICE_NOTIFICATION_ID = 1001;
    public static final int ISLAND_NOTIFICATION_ID = 1002;
    /**
     * vivo рекомендует отменять атомное уведомление по фиксированному тегу.
     * Тот же тег используем и для обновлений.
     */
    public static final String ISLAND_TAG = "VIVO_SUPERX_TAG";

    public static final String PREFS_NAME = "vsu_class_timer_prefs";
    public static final String KEY_SCHED_0 = "sched_0";
    public static final String KEY_SCHED_1 = "sched_1";
    public static final String KEY_ANCHOR_WEEK_TYPE = "anchor_week_type";
    public static final String KEY_ANCHOR_MONDAY = "anchor_monday";
    public static final String KEY_IS_ENABLED = "is_enabled";
    public static final String KEY_VACATION_MODE = "vacation_mode";
    /** Настройка профиля «Показывать отсчёт». */
    public static final String KEY_SHOW_TIMER = "show_timer";
    /** Настройка профиля «Начинать отсчёт»: 0 — с начала дня, >0 — за N часов, -1 — только во время пар. */
    public static final String KEY_START_MODE = "timer_start_mode";
    /** Разовые правки расписания: {"YYYY-MM-DD": ["8:00 - 9:35: ...", ...]}. */
    public static final String KEY_DATE_OVERRIDES = "date_overrides";
    /** Показывался ли островок последним обновлением (нужно после перезапуска процесса). */
    public static final String KEY_ISLAND_ACTIVE = "island_active";

    public static final String ACTION_UPDATE = "com.personal.vsu.schedule.ACTION_UPDATE_TIMER";
    public static final String ACTION_STOP = "com.personal.vsu.schedule.ACTION_STOP_TIMER";
    public static final String ACTION_ALARM = "com.personal.vsu.schedule.ACTION_TIMER_ALARM";

    private static final int ALARM_REQUEST_CODE = 43;
    private static final long TICK_ACTIVE_MS = 1_000L;
    private static final long TICK_IDLE_MS = 60_000L;
    /** Не чаще раза в секунду: капсула островка обновляется посекундно. */
    private static final long MIN_ISLAND_POST_GAP_MS = 750L;
    private static final int START_MODE_ONLY_IN_CLASS = -1;

    private static final String[] DAYS_FULL = {
            "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"
    };

    private static final Pattern LESSON_PATTERN = Pattern.compile("(\\d{1,2}:\\d{2})\\s*-\\s*(\\d{1,2}:\\d{2})\\s*:?\\s*(.*)");

    private final Handler handler = new Handler(Looper.getMainLooper());

    private String lastIslandKey = null;
    /** null — состояние неизвестно (например, после перезапуска процесса). */
    private Boolean islandVisible = null;
    private long lastIslandPostAt = 0;
    private long scheduledAlarmAt = 0;
    private long lastScheduleCheckAt = 0;
    private String lastScheduleKey = "";
    private int lastStateKind = ScheduleState.IDLE;
    private PowerManager.WakeLock wakeLock;

    private final Runnable tickerRunnable = new Runnable() {
        @Override
        public void run() {
            refresh(false);
            long delay = lastStateKind == ScheduleState.IDLE ? TICK_IDLE_MS : TICK_ACTIVE_MS;
            handler.postDelayed(this, delay);
        }
    };

    public static void startOrUpdate(Context context) {
        Intent intent = new Intent(context, ClassTimerService.class);
        intent.setAction(ACTION_UPDATE);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error starting service", e);
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, ClassTimerService.class);
        intent.setAction(ACTION_STOP);
        try {
            // startService, а не startForegroundService: для ACTION_STOP мы не
            // показываем foreground-уведомление и обязаны уложиться в 5 секунд.
            context.startService(intent);
        } catch (Exception e) {
            Log.e(TAG, "Error stopping service", e);
            cancelAllNotifications(context);
            context.stopService(new Intent(context, ClassTimerService.class));
        }
    }

    private static void cancelAllNotifications(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.cancel(ISLAND_TAG, ISLAND_NOTIFICATION_ID);
        manager.cancel(ISLAND_NOTIFICATION_ID);
        manager.cancel(SERVICE_NOTIFICATION_ID);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            handler.removeCallbacks(tickerRunnable);
            cancelAlarm();
            if (!endIsland()) {
                stopForegroundAndSelf();
            }
            return START_NOT_STICKY;
        }

        startInForeground();
        refresh(true);
        handler.removeCallbacks(tickerRunnable);
        handler.postDelayed(tickerRunnable,
                lastStateKind == ScheduleState.IDLE ? TICK_IDLE_MS : TICK_ACTIVE_MS);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tickerRunnable);
        releaseWakeLock();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ─── Уведомления ─────────────────────────────────────────────────────────

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel service = new NotificationChannel(
                CHANNEL_SERVICE,
                "Таймер пар (служебное)",
                NotificationManager.IMPORTANCE_LOW
        );
        service.setDescription("Служебное уведомление, пока таймер пар следит за расписанием");
        service.enableVibration(false);
        service.setSound(null, null);
        service.setShowBadge(false);
        service.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(service);

        NotificationChannel island = new NotificationChannel(
                CHANNEL_ISLAND,
                "Таймер пар (Островок OriginOS)",
                NotificationManager.IMPORTANCE_HIGH
        );
        island.setDescription("Таймер до конца пары для отображения в островке OriginOS");
        island.enableVibration(false);
        island.setSound(null, null);
        island.setShowBadge(false);
        island.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(island);
    }

    private void startInForeground() {
        startForegroundWithNotification(buildServiceNotification());
    }

    private void startForegroundWithNotification(Notification notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int type = 0;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                }
                startForeground(SERVICE_NOTIFICATION_ID, notification, type);
            } else {
                startForeground(SERVICE_NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to startForeground with type", e);
            try {
                startForeground(SERVICE_NOTIFICATION_ID, notification);
            } catch (Exception ignored) {
                // Ниже мы всё равно попробуем показать островок обычным notify().
            }
        }
    }

    private Notification buildServiceNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(R.drawable.ic_stat_timer)
                .setContentTitle("Расписание ВГУ")
                .setContentText("Таймер пар следит за расписанием")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(openAppIntent())
                .build();
    }

    private PendingIntent openAppIntent() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setAction(Intent.ACTION_MAIN);
        openIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return PendingIntent.getActivity(
                this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    // ─── Состояние расписания ────────────────────────────────────────────────

    private static class Lesson {
        String startStr;
        String endStr;
        int startMin;
        int endMin;
        String text;
        String title;
        String room;
        boolean empty;
    }

    private static class ScheduleState {
        static final int IDLE = 0;
        static final int LESSON = 1;
        static final int BREAK = 2;

        int kind = IDLE;
        String key = "";
        String title = "";
        String text = "";
        String leftTitle = "";
        String leftSub = "";
        String rightLabel = "";
        String capsule = "";
        long targetEpoch = 0;
    }

    private ScheduleState buildState() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        ScheduleState state = new ScheduleState();

        if (!prefs.getBoolean(KEY_IS_ENABLED, true)) return state;
        if (prefs.getBoolean(KEY_VACATION_MODE, false)) return state;
        if (!prefs.getBoolean(KEY_SHOW_TIMER, true)) return state;

        int startMode = prefs.getInt(KEY_START_MODE, 0);
        Calendar now = Calendar.getInstance();
        int nowSec = now.get(Calendar.HOUR_OF_DAY) * 3600
                + now.get(Calendar.MINUTE) * 60
                + now.get(Calendar.SECOND);
        int dayIdx = (now.get(Calendar.DAY_OF_WEEK) + 5) % 7; // 0 = Monday, 6 = Sunday
        if (dayIdx >= DAYS_FULL.length) return state;

        List<Lesson> todayLessons = getLessonsForDate(prefs, now);
        if (todayLessons.isEmpty()) return state;

        Lesson currentLesson = null;
        Lesson nextLesson = null;
        for (Lesson l : todayLessons) {
            if (l.empty) continue;
            int startSec = l.startMin * 60;
            int endSec = l.endMin * 60;
            if (nowSec >= startSec && nowSec < endSec) {
                currentLesson = l;
                break;
            }
            if (nowSec < startSec && (nextLesson == null || l.startMin < nextLesson.startMin)) {
                nextLesson = l;
            }
        }

        if (currentLesson != null) {
            int secondsLeft = Math.max(0, currentLesson.endMin * 60 - nowSec);
            String title = currentLesson.title.isEmpty() ? "Пара" : currentLesson.title;
            String room = currentLesson.room;

            state.kind = ScheduleState.LESSON;
            state.key = "lesson:" + currentLesson.startMin + ":" + currentLesson.title;
            state.title = title;
            state.text = "До конца пары: " + formatClock(secondsLeft) + (room.isEmpty() ? "" : " · " + room);
            state.leftTitle = title;
            state.leftSub = room.isEmpty() ? "Пара" : room;
            state.rightLabel = "до конца";
            state.capsule = formatClock(secondsLeft);
            state.targetEpoch = getEpochForTodayMinute(currentLesson.endMin);
            return state;
        }

        if (nextLesson != null) {
            int secondsToStart = Math.max(0, nextLesson.startMin * 60 - nowSec);
            if (startMode == START_MODE_ONLY_IN_CLASS) return state;
            if (startMode > 0 && secondsToStart > (long) startMode * 3600) return state;

            String nextTitle = nextLesson.title.isEmpty() ? "Следующая пара" : nextLesson.title;
            String room = nextLesson.room;

            state.kind = ScheduleState.BREAK;
            state.key = "break:" + nextLesson.startMin + ":" + nextLesson.title;
            state.title = "Перемена";
            state.text = "До начала: " + formatClock(secondsToStart)
                    + (room.isEmpty() ? "" : " · " + room);
            state.leftTitle = "Перемена";
            state.leftSub = nextTitle;
            state.rightLabel = "до начала";
            state.capsule = formatClock(secondsToStart);
            state.targetEpoch = getEpochForTodayMinute(nextLesson.startMin);
            return state;
        }

        // Все пары на сегодня закончились — островок не нужен.
        return state;
    }

    private void refresh(boolean force) {
        ScheduleState state = buildState();
        lastStateKind = state.kind;
        boolean stateChanged = !state.key.equals(lastScheduleKey);
        lastScheduleKey = state.key;

        if (state.kind == ScheduleState.IDLE) {
            endIsland();
        } else {
            postIsland(state, force);
        }

        // Каждую секунду пересчитывать 8 дней расписания незачем: будильники
        // перепланируем при смене состояния/старте и раз в минуту для подстраховки.
        long now = SystemClock.elapsedRealtime();
        if (force || stateChanged || now - lastScheduleCheckAt >= 60_000L) {
            scheduleNextTransition();
            lastScheduleCheckAt = now;
        }
    }

    private void postIsland(ScheduleState state, boolean force) {
        boolean sameState = state.key.equals(lastIslandKey);
        if (sameState && !force
                && SystemClock.elapsedRealtime() - lastIslandPostAt < MIN_ISLAND_POST_GAP_MS) {
            return;
        }

        // OriginOS 7 у сторонних приложений подхватывает островок при
        // создании уведомления. operation=1 оставлял на экране старый
        // текст, поэтому каждый тик отправляем как создание (0).
        int operation = 0;
        startForegroundWithNotification(buildIslandNotification(state, operation));

        boolean wasVisible = Boolean.TRUE.equals(islandVisible);
        lastIslandKey = state.key;
        lastIslandPostAt = SystemClock.elapsedRealtime();
        islandVisible = true;
        // Пока идёт пара, процесс должен просыпаться каждую секунду:
        // иначе OriginOS замораживает handler и секунды «зависают».
        acquireWakeLock();
        if (!wasVisible) {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_ISLAND_ACTIVE, true)
                    .apply();
        }
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vsu:class-timer-island");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) {
                wakeLock.acquire(2 * 60 * 60 * 1000L);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to acquire wake lock", e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to release wake lock", e);
        }
    }

    private Notification buildIslandNotification(ScheduleState state, int operation) {
        PendingIntent contentIntent = openAppIntent();

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ISLAND)
                .setSmallIcon(R.drawable.ic_stat_timer)
                .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher))
                .setContentTitle(state.title)
                .setContentText(state.text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setWhen(state.targetEpoch)
                .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(contentIntent);

        Bundle islandBundle = new Bundle();
        islandBundle.putBoolean("island.superx.forceShow", true);
        islandBundle.putBoolean("island.superx.forceShowCard", false);
        islandBundle.putBoolean("island.superx.permanent", true);
        islandBundle.putBoolean("island.superx.showBarWhenCard", true);
        islandBundle.putInt("island.superx.priority", 4);
        islandBundle.putInt("island.superx.template", 0);
        islandBundle.putInt("island.superx.islandType", 2);
        islandBundle.putInt("island.superx.leftTemplate", 1);
        islandBundle.putInt("island.superx.rightTemplate", 4);
        islandBundle.putInt("island.superx.islandClick", 1);
        islandBundle.putInt("island.superx.operation", operation);
        islandBundle.putParcelable("island.superx.clickResp", contentIntent);
        islandBundle.putString("island.superx.landingPkg", getPackageName());
        islandBundle.putString("island.superx.landingInfo", "{\"pkn\":\"" + getPackageName() + "\",\"activityName\":\"" + getPackageName() + ".MainActivity\",\"supportActivity\":true,\"type\":\"app\"}");

        islandBundle.putString("island.superx.rightInfo.content", state.capsule);
        islandBundle.putString("island.superx.rightInfo.capsuleContent", state.capsule);
        islandBundle.putInt("island.superx.rightInfo.capsuleBgColor", Color.parseColor("#33FFFFFF"));
        islandBundle.putParcelable("island.superx.rightInfo.clickResp", contentIntent);
        islandBundle.putString("island.superx.leftInfo.content", state.leftTitle);

        Icon icon = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            icon = Icon.createWithResource(this, R.drawable.ic_stat_timer);
            islandBundle.putParcelable("island.superx.leftInfo.icon", icon);
        }

        ArrayList<CharSequence> leftDouble = new ArrayList<>();
        leftDouble.add(state.leftTitle);
        leftDouble.add(state.leftSub);
        islandBundle.putCharSequenceArrayList("island.superx.leftInfo.doublelineText", leftDouble);

        ArrayList<CharSequence> rightDouble = new ArrayList<>();
        rightDouble.add(state.rightLabel);
        rightDouble.add(state.capsule);
        islandBundle.putCharSequenceArrayList("island.superx.rightInfo.doublelineText", rightDouble);

        Bundle leftInfo = new Bundle();
        if (icon != null) {
            leftInfo.putParcelable("island.superx.leftInfo.icon", icon);
            leftInfo.putParcelable("icon", icon);
        }
        leftInfo.putString("island.superx.leftInfo.content", state.leftTitle);
        leftInfo.putString("content", state.leftTitle);
        leftInfo.putString("title", state.leftTitle);
        leftInfo.putString("subTitle", state.leftSub);
        leftInfo.putCharSequenceArrayList("island.superx.leftInfo.doublelineText", leftDouble);
        leftInfo.putCharSequenceArrayList("doublelineText", leftDouble);
        islandBundle.putBundle("island.superx.leftInfo", leftInfo);

        Bundle rightInfo = new Bundle();
        rightInfo.putString("island.superx.rightInfo.content", state.capsule);
        rightInfo.putString("content", state.capsule);
        rightInfo.putString("island.superx.rightInfo.capsuleContent", state.capsule);
        rightInfo.putString("capsuleContent", state.capsule);
        rightInfo.putInt("island.superx.rightInfo.capsuleBgColor", Color.parseColor("#33FFFFFF"));
        rightInfo.putInt("capsuleBgColor", Color.parseColor("#33FFFFFF"));
        rightInfo.putParcelable("island.superx.rightInfo.clickResp", contentIntent);
        rightInfo.putParcelable("clickResp", contentIntent);
        rightInfo.putCharSequenceArrayList("island.superx.rightInfo.doublelineText", rightDouble);
        rightInfo.putCharSequenceArrayList("doublelineText", rightDouble);
        rightInfo.putLong("targetTime", state.targetEpoch);
        rightInfo.putBoolean("isCountDown", true);
        islandBundle.putBundle("island.superx.rightInfo", rightInfo);

        builder.getExtras().putBundle("notification.superx.island", islandBundle);
        builder.getExtras().putBoolean("notification.superx.islandNotify", true);
        builder.getExtras().putInt("notification.superx.operation", operation);
        builder.getExtras().putBoolean("notification.superx.showNotify", true);
        builder.getExtras().putString("SUPERX_VALUE", "true");
        builder.getExtras().putString("notification.superx.capsule.content", state.capsule);
        builder.getExtras().putInt("notification.superx.capsule.state", 1);
        builder.getExtras().putString("notification.superx.infos.coreInfo", state.leftTitle);

        return builder.build();
    }

    private boolean endIsland() {
        boolean posted;
        if (islandVisible != null) {
            posted = islandVisible;
        } else {
            // После перезапуска процесса не знаем, висит ли островок: смотрим prefs.
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            posted = prefs.getBoolean(KEY_ISLAND_ACTIVE, false);
        }

        if (!posted) {
            islandVisible = false;
            lastIslandKey = null;
            releaseWakeLock();
            return false;
        }

        // operation=2 отправляем через foreground-уведомление: именно этот путь
        // система принимает у сторонних приложений.
        startForegroundWithNotification(buildIslandEndNotification());

        // Если островок не убрался одним operation=2, полностью снимаем
        // foreground-уведомление и останавливаем сервис. На следующую пару
        // его разбудит точный будильник.
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!Boolean.FALSE.equals(islandVisible)) return;
                stopForegroundAndSelf();
            }
        }, 1_200L);

        // Уведомление могло остаться от предыдущих сборок, где островок
        // публиковался отдельно от foreground-сервиса.
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(ISLAND_TAG, ISLAND_NOTIFICATION_ID);
            manager.cancel(ISLAND_NOTIFICATION_ID);
        }

        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_ISLAND_ACTIVE, false)
                .apply();
        islandVisible = false;
        lastIslandKey = null;
        releaseWakeLock();
        return true;
    }

    /** Жёстко убирает foreground-уведомление и останавливает сервис. */
    private void stopForegroundAndSelf() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            // В том числе копия, которую OriginOS помечает тегом VIVO_SUPERX_TAG.
            manager.cancel(ISLAND_TAG, SERVICE_NOTIFICATION_ID);
            manager.cancel(SERVICE_NOTIFICATION_ID);
            manager.cancel(ISLAND_TAG, ISLAND_NOTIFICATION_ID);
            manager.cancel(ISLAND_NOTIFICATION_ID);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    private Notification buildIslandEndNotification() {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ISLAND)
                .setSmallIcon(R.drawable.ic_stat_timer)
                .setContentTitle("Расписание ВГУ")
                .setContentText("Таймер пар следит за расписанием")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(false)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(openAppIntent());

        Bundle islandBundle = new Bundle();
        islandBundle.putInt("notification.superx.operation", 2);
        islandBundle.putBoolean("notification.superx.showNotify", false);
        islandBundle.putInt("island.superx.operation", 2);
        islandBundle.putBoolean("island.superx.forceShow", false);
        islandBundle.putBoolean("island.superx.forceShowCard", false);
        islandBundle.putBoolean("island.superx.permanent", false);
        islandBundle.putBoolean("island.superx.dismissCard", true);
        islandBundle.putString("island.superx.landingPkg", getPackageName());

        builder.getExtras().putBundle("notification.superx.island", islandBundle);
        builder.getExtras().putBoolean("notification.superx.islandNotify", false);
        builder.getExtras().putInt("notification.superx.operation", 2);
        builder.getExtras().putBoolean("notification.superx.showNotify", false);

        return builder.build();
    }

    // ─── Пробуждения на границах пар ─────────────────────────────────────────

    private void scheduleNextTransition() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        long next = computeNextTransition(prefs);
        if (next <= 0) {
            cancelAlarm();
            return;
        }
        if (Math.abs(next - scheduledAlarmAt) < 2_000L) return;

        AlarmManager alarmManager = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        PendingIntent pendingIntent = buildAlarmIntent();
        alarmManager.cancel(pendingIntent);

        long triggerAt = Math.max(next, System.currentTimeMillis() + 1_000L);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            } else {
                alarmManager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            }
            scheduledAlarmAt = next;
        } catch (SecurityException e) {
            Log.w(TAG, "Exact alarm not allowed, falling back", e);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            }
            scheduledAlarmAt = next;
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule alarm", e);
        }
    }

    private PendingIntent buildAlarmIntent() {
        Intent intent = new Intent(this, ClassTimerAlarmReceiver.class);
        intent.setAction(ACTION_ALARM);
        return PendingIntent.getBroadcast(
                this, ALARM_REQUEST_CODE, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void cancelAlarm() {
        AlarmManager alarmManager = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;
        alarmManager.cancel(buildAlarmIntent());
        scheduledAlarmAt = 0;
    }

    /**
     * Ближайший момент, когда видимое состояние островка может измениться:
     * начало/конец пары, окно «за N часов» и полночь.
     */
    private long computeNextTransition(SharedPreferences prefs) {
        if (!prefs.getBoolean(KEY_IS_ENABLED, true)) return 0;
        if (prefs.getBoolean(KEY_VACATION_MODE, false)) return 0;
        if (!prefs.getBoolean(KEY_SHOW_TIMER, true)) return 0;

        int startMode = prefs.getInt(KEY_START_MODE, 0);
        long now = System.currentTimeMillis();
        long best = Long.MAX_VALUE;

        Calendar day = Calendar.getInstance();
        day.set(Calendar.HOUR_OF_DAY, 0);
        day.set(Calendar.MINUTE, 0);
        day.set(Calendar.SECOND, 0);
        day.set(Calendar.MILLISECOND, 0);

        for (int i = 0; i < 8; i++) {
            Calendar nextDay = (Calendar) day.clone();
            nextDay.add(Calendar.DAY_OF_YEAR, 1);
            best = minFuture(best, nextDay.getTimeInMillis(), now);

            List<Lesson> lessons = getLessonsForDate(prefs, day);
            boolean hasLessons = false;
            for (Lesson l : lessons) {
                if (!l.empty) {
                    hasLessons = true;
                    break;
                }
            }

            if (hasLessons) {
                if (startMode == 0) {
                    best = minFuture(best, day.getTimeInMillis(), now);
                }
                for (Lesson l : lessons) {
                    if (l.empty) continue;
                    long start = epochForDateMinute(day, l.startMin);
                    long end = epochForDateMinute(day, l.endMin);
                    if (startMode > 0) {
                        best = minFuture(best, epochForDateMinute(day, l.startMin - startMode * 60), now);
                    }
                    best = minFuture(best, start, now);
                    best = minFuture(best, end, now);
                }
            }

            day.add(Calendar.DAY_OF_YEAR, 1);
        }

        return best == Long.MAX_VALUE ? 0 : best;
    }

    private long minFuture(long best, long candidate, long now) {
        return candidate > now + 1_000L && candidate < best ? candidate : best;
    }

    // ─── Работа с расписанием ────────────────────────────────────────────────

    private String formatDuration(int minutes) {
        if (minutes >= 60) {
            int h = minutes / 60;
            int m = minutes % 60;
            return m > 0 ? (h + "ч " + m + "м") : (h + "ч");
        }
        return minutes + " мин";
    }

    /** Отсчёт с секундами: MM:SS, а для пары длиннее часа — H:MM:SS. */
    private String formatClock(int totalSeconds) {
        int s = Math.max(0, totalSeconds);
        int h = s / 3600;
        int m = (s % 3600) / 60;
        int sec = s % 60;
        if (h > 0) return String.format(Locale.US, "%d:%02d:%02d", h, m, sec);
        return String.format(Locale.US, "%02d:%02d", m, sec);
    }

    private long epochForDateMinute(Calendar baseDay, int minuteOfDay) {
        Calendar c = (Calendar) baseDay.clone();
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        c.add(Calendar.MINUTE, minuteOfDay);
        return c.getTimeInMillis();
    }

    private long getEpochForTodayMinute(int minuteOfDay) {
        Calendar c = Calendar.getInstance();
        c.set(Calendar.HOUR_OF_DAY, minuteOfDay / 60);
        c.set(Calendar.MINUTE, minuteOfDay % 60);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    private int calculateWeekType(SharedPreferences prefs, Calendar now) {
        try {
            int anchorWeekType = prefs.getInt(KEY_ANCHOR_WEEK_TYPE, 0);
            String anchorMondayStr = prefs.getString(KEY_ANCHOR_MONDAY, null);
            if (anchorMondayStr == null || anchorMondayStr.isEmpty()) {
                return 0;
            }

            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            Date anchorMonday = sdf.parse(anchorMondayStr);
            if (anchorMonday == null) return 0;

            Calendar curMonday = (Calendar) now.clone();
            int curDayOfWeek = curMonday.get(Calendar.DAY_OF_WEEK);
            int curDayIdx = (curDayOfWeek + 5) % 7; // 0 = Monday
            curMonday.add(Calendar.DAY_OF_YEAR, -curDayIdx);
            curMonday.set(Calendar.HOUR_OF_DAY, 0);
            curMonday.set(Calendar.MINUTE, 0);
            curMonday.set(Calendar.SECOND, 0);
            curMonday.set(Calendar.MILLISECOND, 0);

            long diffMillis = curMonday.getTimeInMillis() - anchorMonday.getTime();
            int diffWeeks = (int) Math.round(diffMillis / (7.0 * 86400000.0));
            return ((anchorWeekType + diffWeeks) % 2 + 2) % 2;
        } catch (Exception e) {
            Log.e(TAG, "Error calculating week type", e);
            return 0;
        }
    }

    private List<Lesson> getLessonsForDate(SharedPreferences prefs, Calendar day) {
        // Разовая локальная правка важнее расписания на неделю.
        String iso = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(day.getTime());
        String rawOverrides = prefs.getString(KEY_DATE_OVERRIDES, null);
        if (rawOverrides != null && !rawOverrides.isEmpty()) {
            try {
                JSONObject obj = new JSONObject(rawOverrides);
                JSONArray arr = obj.optJSONArray(iso);
                if (arr != null) {
                    return parseLessonArray(arr);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error parsing date overrides", e);
            }
        }

        int dayIdx = (day.get(Calendar.DAY_OF_WEEK) + 5) % 7;
        if (dayIdx < 0 || dayIdx >= DAYS_FULL.length) return new ArrayList<>();
        int weekType = calculateWeekType(prefs, day);
        return getLessonsForDay(prefs, weekType, DAYS_FULL[dayIdx]);
    }

    private List<Lesson> parseLessonArray(JSONArray arr) {
        List<Lesson> result = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            Lesson l = parseLesson(arr.optString(i, ""));
            if (l != null) result.add(l);
        }
        return result;
    }

    private List<Lesson> getLessonsForDay(SharedPreferences prefs, int weekType, String dayName) {
        List<Lesson> result = new ArrayList<>();
        String key = (weekType == 0) ? KEY_SCHED_0 : KEY_SCHED_1;
        String rawJson = prefs.getString(key, null);
        if (rawJson == null || rawJson.isEmpty()) return result;

        try {
            JSONObject obj = new JSONObject(rawJson);
            JSONArray arr = obj.optJSONArray(dayName);
            if (arr == null) return result;

            for (int i = 0; i < arr.length(); i++) {
                String raw = arr.getString(i);
                Lesson l = parseLesson(raw);
                if (l != null) {
                    result.add(l);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error parsing schedule JSON", e);
        }

        return result;
    }

    private Lesson parseLesson(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        Lesson lesson = new Lesson();
        lesson.empty = raw.trim().startsWith("▫") || raw.trim().startsWith("\u25ab");

        String cleaned = raw.replaceAll("[*_]", "").replaceAll("^[🔹▫️\\s]+", "").trim();
        Matcher m = LESSON_PATTERN.matcher(cleaned);
        if (!m.matches()) {
            return null;
        }

        lesson.startStr = m.group(1);
        lesson.endStr = m.group(2);
        lesson.text = m.group(3).trim();

        lesson.startMin = parseTimeMin(lesson.startStr);
        lesson.endMin = parseTimeMin(lesson.endStr);

        lesson.title = extractTitle(lesson.text);
        lesson.room = extractRoom(lesson.text);

        return lesson;
    }

    private int parseTimeMin(String t) {
        if (t == null) return 0;
        String[] parts = t.split(":");
        if (parts.length != 2) return 0;
        try {
            return Integer.parseInt(parts[0].trim()) * 60 + Integer.parseInt(parts[1].trim());
        } catch (Exception e) {
            return 0;
        }
    }

    private String extractTitle(String full) {
        if (full == null || full.isEmpty()) return "";
        int paren = full.indexOf('(');
        int aud = full.toLowerCase().indexOf("ауд");
        int cut = full.length();
        if (paren > 0 && paren < cut) cut = paren;
        if (aud > 0 && aud < cut) cut = aud;
        return full.substring(0, cut).trim();
    }

    private String extractRoom(String full) {
        if (full == null) return "";
        Matcher m = Pattern.compile("ауд\\.?\\s*(\\S+)", Pattern.CASE_INSENSITIVE).matcher(full);
        if (m.find()) {
            return "ауд. " + m.group(1);
        }
        return "";
    }
}

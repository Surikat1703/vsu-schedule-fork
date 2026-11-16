package com.personal.vsu.schedule;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.util.Log;

/**
 * Точный будильник на границе пары. Нужен потому, что Handler в фоне
 * засыпает вместе с процессом: без него островок мог «зависнуть» на
 * последней паре до следующего открытия приложения.
 */
public class ClassTimerAlarmReceiver extends BroadcastReceiver {
    private static final String TAG = "ClassTimerAlarm";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ClassTimerService.ACTION_ALARM.equals(intent.getAction())) return;

        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = null;
        if (powerManager != null) {
            try {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vsu:class-timer-alarm");
                wakeLock.acquire(10_000L);
            } catch (Exception e) {
                Log.w(TAG, "Failed to acquire wake lock", e);
            }
        }

        try {
            ClassTimerService.startOrUpdate(context);
        } catch (Exception e) {
            Log.e(TAG, "Failed to refresh timer", e);
        } finally {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        }
    }
}

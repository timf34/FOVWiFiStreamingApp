// hotspotUtils.js
import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

/**
 * Opens the vendor hotspot / tethering screen on (almost) every phone.
 * Falls back to generic Wi-Fi settings.
 */
export async function openHotspotSettings() {
  if (Platform.OS !== 'android') return;

  // Samsung & AOSP 11+ (also OnePlus, Huawei)
  try {
    await IntentLauncher.startActivityAsync('android.settings.WIFI_AP_SETTINGS');
    return;
  } catch {}

  // Pixels, Xiaomi, many others
  try {
    await IntentLauncher.startActivityAsync('android.settings.TETHER_SETTINGS');
    return;
  } catch {}

  // Fallback: Wi-Fi panel (user can tap “Hotspot & tethering” manually)
  await IntentLauncher.startActivityAsync(
    IntentLauncher.ActivityAction.WIFI_SETTINGS
  );
}

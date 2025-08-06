// nfcUtils.js
import { Ndef } from 'react-native-nfc-manager';
import { Buffer } from 'buffer';

/**
 * Reads either:
 *   • Custom MIME record  application/vnd.fov.device   (legacy Android tags)
 *   • NDEF Text record    payload = FOV-ESP32-01       (new simple tags)
 *   • (optional) URI record fovconnector://FOV-ESP32-01
 */
export function getDeviceName(tag) {
  if (!tag?.ndefMessage?.length) return null;

  for (const rec of tag.ndefMessage) {
    /* ── 1. Custom MIME path ───────────────────────────────────────── */
    if (rec.tnf === Ndef.TNF_MIME_MEDIA) {
      const typeStr = Ndef.util.bytesToString(rec.type);      // "application/vnd.fov.device"
      if (typeStr === 'application/vnd.fov.device') {
        return Buffer.from(rec.payload).toString('utf8');     // → "FOV-ESP32-01"
      }
    }

    /* ── 2. Text record path ───────────────────────────────────────── */
    if (
      rec.tnf === Ndef.TNF_WELL_KNOWN &&
      Ndef.util.bytesToString(rec.type) === 'T'
    ) {
      return Ndef.text.decodePayload(rec.payload);            // → "FOV-ESP32-01"
    }

    /* ── 3. (Optional) URI record path ─────────────────────────────── */
    if (
      rec.tnf === Ndef.TNF_WELL_KNOWN &&
      Ndef.util.bytesToString(rec.type) === 'U'
    ) {
      const uri = Ndef.uri.decodePayload(rec.payload);        // e.g. "fovconnector://FOV-ESP32-01"
      return uri.split('://').pop();                          // crude parse
    }
  }
  return null;
}

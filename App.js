import React, { useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  View,
  FlatList,
  TouchableOpacity,
  Text,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  Alert,
  ActivityIndicator,
  TextInput,
  Linking,
} from 'react-native';

import { BleManager } from 'react-native-ble-plx';
import base64 from 'base-64';
import NfcManager, { NfcEvents } from 'react-native-nfc-manager';
import { getDeviceName } from './nfcUtils';
import { openHotspotSettings } from './hotspotUtils';


// --- ESP32 service & characteristic (edit if yours differ) -------------
const SERVICE_UUID        = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
// ------------------------------------------------------------------------

const manager = new BleManager();
manager.onStateChange(state => console.log('[BLE] state =', state), true);

export default function App() {
  /* ------------------------------------------------------------------- */
  /* State                                                               */
  /* ------------------------------------------------------------------- */
  const [iosScanning, setIosScanning] = useState(false);
  const [scanning, setScanning]               = useState(false);
  const [devices,  setDevices]                = useState([]);   // [{id,name}]
  const [connectedDevice, setConnectedDevice] = useState(null); // BleDevice
  const [sending, setSending]                 = useState(false);
  const [nfcEnabled, setNfcEnabled]           = useState(false);
  const [ssid, setSsid]                      = useState('');
  const [password, setPassword]               = useState('');
  const [sendingWifi, setSendingWifi]         = useState(false);
  const [wifiStatus, setWifiStatus]           = useState(null); // NEW: Track WiFi connection status
  const [subscription, setSubscription]       = useState(null); // NEW: Track notification subscription
  const scanRef = useRef(null);

  // ──────────────────────────────── iOS NFC helpers ────────────────────────────────
  async function startIosNfcScan() {
    if (Platform.OS !== 'ios' || iosScanning) return;
    try {
      await NfcManager.registerTagEvent(
        onTagDiscovered,
        'Hold iPhone near the tag',
        { invalidateAfterFirstRead: true }
      );
      setIosScanning(true);
    } catch (err) {
      if (err?.code !== 204) console.warn('NFC start error', err);
    }
  }

  async function stopIosNfcScan() {
    if (Platform.OS !== 'ios' || !iosScanning) return;
    try { await NfcManager.unregisterTagEvent(); } catch {}
    setIosScanning(false);
  }

  /* ------------------------------------------------------------------- */
  /* Permissions (Android)                                               */
  /* ------------------------------------------------------------------- */
  useEffect(() => {
    async function requestPermissions() {
      if (Platform.OS !== 'android') return;
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      const allGranted = Object.values(granted)
        .every(res => res === PermissionsAndroid.RESULTS.GRANTED);
      if (!allGranted) Alert.alert('Permission needed',
        'Bluetooth permissions are required for scanning');
    }
    requestPermissions();
  }, []);

  /* ------------------------------------------------------------------- */
  /* NFC Setup                                                           */
  /* ------------------------------------------------------------------- */
  useEffect(() => {
    async function initNfc() {
      const supported = await NfcManager.isSupported();
      if (!supported) {
        console.log('NFC not supported on this device');
        return;
      }
      
      try {
        await NfcManager.start();
        setNfcEnabled(true);
        
        // Listen for any tag while app is in foreground
        NfcManager.setEventListener(NfcEvents.DiscoverTag, onTagDiscovered);
        if (Platform.OS === 'android') {
          await NfcManager.registerTagEvent();
        }
      } catch (err) {
        console.warn('NFC initialization failed:', err);
      }
    }
    
    initNfc();

    // Cleanup
    return () => {
      NfcManager.setEventListener(NfcEvents.DiscoverTag, null);
      NfcManager.unregisterTagEvent().catch(() => 0);
    };
  }, []);

  /* ------------------------------------------------------------------- */
  /* iOS: wait for Bluetooth to turn on                                  */
  /* ------------------------------------------------------------------- */
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const sub = manager.onStateChange((state) => {
      if (state === 'PoweredOn') {
        sub.remove();           // ready – allow user to scan
      }
    }, true);                   // `true` ⇒ get current state immediately

    return () => sub.remove();
  }, []);

  /* ------------------------------------------------------------------- */
  /* NFC Tag Handler                                                     */
  /* ------------------------------------------------------------------- */
  const onTagDiscovered = async tag => {
    const deviceName = getDeviceName(tag);
    if (!deviceName) return;

    console.log('NFC tag says to connect to:', deviceName);

    // Quick UX feedback on iOS
    if (Platform.OS === 'ios') {
      NfcManager.setAlertMessageIOS('Connecting to ' + deviceName);
      // re‑start reader session shortly after it auto‑invalidates
      setTimeout(startIosNfcScan, 400);
    }

    // If we're already connected to this device, do nothing
    if (connectedDevice?.name === deviceName) return;

    // Scan for the specific device
    stopScan();
    setScanning(true);
    const SCAN_TIMEOUT = 15000; // 15-second safety net
    const timeoutId = setTimeout(stopScan, SCAN_TIMEOUT);

    scanRef.current = manager.startDeviceScan(
      null,
      { allowDuplicates: false },
      (error, device) => {
        if (error) {
          Alert.alert('Scan error', error.message);
          stopScan();
          return;
        }
        if (device?.name === deviceName) {
          console.log('Found device from NFC tag:', deviceName);
          clearTimeout(timeoutId);
          manager.stopDeviceScan();
          setScanning(false);
          connect({ id: device.id, name: deviceName });
        }
      }
    );
  };

  /* ------------------------------------------------------------------- */
  /* Scan for devices                                                    */
  /* ------------------------------------------------------------------- */
  const startScan = () => {
    if (scanning) return;
    setDevices([]);
    setScanning(true);

    const serviceFilter = null; 
    scanRef.current = manager.startDeviceScan(
      serviceFilter,
      { allowDuplicates: false },
      (error, device) => {
        if (error) {
          Alert.alert('Scan error', error.message);
          setScanning(false);
          return;
        }
        if (device && device.name) {
          setDevices(prev => {
            // dedupe by id
            if (prev.find(d => d.id === device.id)) return prev;
            return [...prev, { id: device.id, name: device.name }];
          });
        }
      });

    // stop automatically after 10 s
    setTimeout(stopScan, 10000);
  };

  const stopScan = () => {
    if (scanRef.current) manager.stopDeviceScan();
    setScanning(false);
  };

  /* ------------------------------------------------------------------- */
  /* Handle incoming notifications from ESP32                            */
  /* ------------------------------------------------------------------- */
  const handleNotification = (error, characteristic) => {
    if (error) {
      console.error('Notification error:', error);
      return;
    }

    if (!characteristic?.value) return;

    try {
      const decoded = base64.decode(characteristic.value);
      console.log('Notification received:', decoded);
      
      // Try to parse as JSON for status updates
      try {
        const data = JSON.parse(decoded);
        
        // Handle WiFi status updates
        if (data.status === 'wifi_connected') {
          setWifiStatus({
            connected: true,
            ip: data.ip,
            rssi: data.rssi
          });
          Alert.alert(
            'WiFi Connected! 🎉', 
            `IP Address: ${data.ip}\nSignal Strength: ${data.rssi} dBm`
          );
        } else if (data.status === 'wifi_failed') {
          setWifiStatus({
            connected: false,
            error: data.error
          });
          Alert.alert(
            'WiFi Connection Failed', 
            'Please check your credentials and try again'
          );
        }
      } catch (e) {
        // Not JSON, just a regular message
        console.log('Regular message:', decoded);
      }
    } catch (err) {
      console.error('Error decoding notification:', err);
    }
  };

  /* ------------------------------------------------------------------- */
  /* Connect / disconnect                                                */
  /* ------------------------------------------------------------------- */
  const connect = async ({ id, name }) => {
    try {
      stopScan();
      const device = await manager.connectToDevice(id, { timeout: 8000 });
      await device.discoverAllServicesAndCharacteristics();
      
      // Subscribe to notifications
      const sub = await device.monitorCharacteristicForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        handleNotification
      );
      setSubscription(sub);
      
      setConnectedDevice(device);
      setWifiStatus(null); // Reset WiFi status on new connection
      Alert.alert('Connected', `Connected to ${name}`);
    } catch (err) {
      Alert.alert('Connection error', err.message);
    }
  };

  const disconnect = async () => {
    try {
      if (subscription) {
        subscription.remove();
        setSubscription(null);
      }
      await manager.cancelDeviceConnection(connectedDevice.id);
    } catch {}
    setConnectedDevice(null);
    setWifiStatus(null);
  };

  /* ------------------------------------------------------------------- */
  /* Send "hello world"                                                  */
  /* ------------------------------------------------------------------- */
  const sendHello = async () => {
    if (!connectedDevice) return;
    setSending(true);
    try {
      const payload = JSON.stringify({
        message: 'hello world',
        timestamp: Date.now(),
      }) + '\n';
      const encoded = base64.encode(payload);
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        encoded
      );
      Alert.alert('Sent', 'Message sent successfully 🎉');
    } catch (err) {
      Alert.alert('Send error', err.message);
    } finally {
      setSending(false);
    }
  };

  /* ------------------------------------------------------------------- */
  /* Send Wi-Fi credentials                                              */
  /* ------------------------------------------------------------------- */
  const sendWifiCredentials = async () => {
    if (!connectedDevice) return;
    setSendingWifi(true);
    setWifiStatus(null); // Reset status before new attempt
    try {
      const payload = JSON.stringify({
        wifiSsid: ssid,
        wifiPassword: password,
      }) + '\n';
      const encoded = base64.encode(payload);
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        encoded
      );
      // Don't show success alert here - wait for the actual connection status
      console.log('WiFi credentials sent, waiting for connection status...');
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setSendingWifi(false);
    }
  };

  /* ------------------------------------------------------------------- */
  /* UI                                                                  */
  /* ------------------------------------------------------------------- */
  const DeviceRow = ({ item }) => (
    <TouchableOpacity
      style={styles.deviceRow}
      onPress={() => connect(item)}
    >
      <Text style={styles.deviceName}>{item.name}</Text>
      <Text style={styles.deviceId}>{item.id}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>

      {/* ---------- HEADER ---------- */}
      <Text style={styles.title}>Field-of-Vision BLE Demo</Text>

      {/* ---------- NFC STATUS ---------- */}
      {Platform.OS === 'android' && (
        <Text style={styles.nfcStatus}>
          {nfcEnabled ? 'NFC Ready - Tap a tag to connect' : 'NFC Not Available'}
        </Text>
      )}

      {/* ---------- CONNECTED STATE ---------- */}
      {connectedDevice ? (
        <>
          <Text style={styles.connectedText}>
            ✅ Connected to {connectedDevice.name || connectedDevice.id}
          </Text>

          <TouchableOpacity
            style={styles.button}
            onPress={sendHello}
            disabled={sending}
          >
            {sending
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonLabel}>Send "hello world"</Text>}
          </TouchableOpacity>

          {/* WiFi credential section - now available on both platforms */}
          <>
            {Platform.OS === 'android' && (
              <TouchableOpacity
                style={[styles.button, {backgroundColor:'#4caf50'}]}
                onPress={openHotspotSettings}
              >
                <Text style={styles.buttonLabel}>Open Hotspot Settings</Text>
              </TouchableOpacity>
            )}

            {Platform.OS === 'ios' && (
              <>
                <Text style={styles.instructions}>
                  To share your hotspot: Go to Settings → Personal Hotspot
                </Text>
                <TouchableOpacity
                  style={[styles.button, {backgroundColor:'#ff9800', marginBottom: 8}]}
                  onPress={() => {
                    setSsid("iPhone");
                    Alert.alert(
                      'Tip',
                      'iOS hotspot names are usually "iPhone" or "[Your Name]\'s iPhone". You can check in Settings → General → About → Name'
                    );
                  }}
                >
                  <Text style={styles.buttonLabel}>Use Default iPhone SSID</Text>
                </TouchableOpacity>
              </>
            )}

            <View style={styles.row}>
              <TextInput
                style={styles.input}
                placeholder="SSID"
                value={ssid}
                onChangeText={setSsid}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={styles.input}
                placeholder="Password"
                value={password}
                secureTextEntry
                onChangeText={setPassword}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <TouchableOpacity
              style={[styles.button, {backgroundColor:'#673ab7'}]}
              onPress={sendWifiCredentials}
              disabled={sendingWifi || !ssid || !password}
            >
              {sendingWifi
                ? <ActivityIndicator color="#fff"/>
                : <Text style={styles.buttonLabel}>Send Wi-Fi Credentials</Text>}
            </TouchableOpacity>

            {/* WiFi Status Display */}
            {wifiStatus && (
              <View style={[styles.statusBox, wifiStatus.connected ? styles.statusSuccess : styles.statusError]}>
                <Text style={styles.statusTitle}>
                  {wifiStatus.connected ? '🟢 WiFi Connected' : '🔴 WiFi Connection Failed'}
                </Text>
                {wifiStatus.connected ? (
                  <>
                    <Text style={styles.statusText}>IP: {wifiStatus.ip}</Text>
                    <Text style={styles.statusText}>Signal: {wifiStatus.rssi} dBm</Text>
                  </>
                ) : (
                  <Text style={styles.statusText}>Error: {wifiStatus.error || 'Unknown error'}</Text>
                )}
              </View>
            )}

            {sendingWifi && (
              <View style={styles.statusBox}>
                <ActivityIndicator color="#2196f3" />
                <Text style={styles.statusText}>Connecting to WiFi...</Text>
                <Text style={styles.statusSubtext}>This may take up to 15 seconds</Text>
              </View>
            )}
          </>

          <TouchableOpacity
            style={[styles.button, styles.secondary]}
            onPress={disconnect}
          >
            <Text style={styles.buttonLabel}>Disconnect</Text>
          </TouchableOpacity>
        </>
      ) : (
      /* ---------- DISCONNECTED STATE ---------- */
        <>
          {Platform.OS === 'ios' && (
            <TouchableOpacity
              style={[styles.button, iosScanning && styles.secondary]}
              onPress={iosScanning ? stopIosNfcScan : startIosNfcScan}
            >
              <Text style={styles.buttonLabel}>
                {iosScanning ? 'Stop NFC Scan' : 'Scan NFC Tag'}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.button}
            onPress={scanning ? stopScan : startScan}
          >
            <Text style={styles.buttonLabel}>
              {scanning ? 'Stop scan' : 'Scan for devices'}
            </Text>
          </TouchableOpacity>

          <FlatList
            data={devices}
            keyExtractor={item => item.id}
            renderItem={DeviceRow}
            ListEmptyComponent={
              scanning
                ? <Text style={styles.muted}>Scanning…</Text>
                : <Text style={styles.muted}>No devices yet</Text>}
          />
        </>
      )}
    </SafeAreaView>
  );
}

/* --------------------------------------------------------------------- */
/* Styles                                                                */
/* --------------------------------------------------------------------- */
const styles = StyleSheet.create({
  container:     { flex: 1, padding: 16, backgroundColor: '#f7f7f7' },
  title:         { fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  nfcStatus:     { fontSize: 14, color: '#666', marginBottom: 12, textAlign: 'center' },
  connectedText: { marginVertical: 12, fontSize: 16 },
  deviceRow:     {
    backgroundColor: '#fff', padding: 12, marginBottom: 8,
    borderRadius: 6, elevation: 1,
  },
  deviceName:    { fontWeight: '600' },
  deviceId:      { fontSize: 12, color: '#666' },
  button:        {
    backgroundColor: '#2196f3', padding: 14, borderRadius: 6,
    alignItems: 'center', marginBottom: 12,
  },
  secondary:     { backgroundColor: '#9e9e9e' },
  buttonLabel:   { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  muted:         { textAlign: 'center', color: '#888', marginTop: 20 },
  row:           { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input:         { 
    flex: 1, 
    borderWidth: 1, 
    borderColor: '#ccc', 
    borderRadius: 4, 
    padding: 8,
    fontSize: 16,
  },
  instructions:  { 
    fontSize: 14, 
    color: '#666', 
    marginBottom: 12, 
    textAlign: 'center',
    fontStyle: 'italic',
  },
  statusBox: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
  },
  statusSuccess: {
    backgroundColor: '#e8f5e9',
    borderWidth: 1,
    borderColor: '#4caf50',
  },
  statusError: {
    backgroundColor: '#ffebee',
    borderWidth: 1,
    borderColor: '#f44336',
  },
  statusTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  statusText: {
    fontSize: 14,
    color: '#333',
  },
  statusSubtext: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
});
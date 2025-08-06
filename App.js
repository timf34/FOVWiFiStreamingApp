import React, { useEffect, useState, useRef } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  TextInput,
  Switch,
  AppState,
  Platform,
} from 'react-native';
import { BleManager } from './bleManager';
import { StreamClient } from './streamClient';
import { Protocol } from './protocol';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ESP32 UUIDs from your existing code
const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

export default function App() {
  // Connection states
  const [bleDevice, setBleDevice] = useState(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState([]);
  
  // Configuration
  const [streamUrl, setStreamUrl] = useState('wss://your-stream.example.com');
  const [useBinaryProtocol, setUseBinaryProtocol] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  
  // Statistics
  const [stats, setStats] = useState({
    messagesSent: 0,
    messagesQueued: 0,
    avgLatency: 0,
    lastError: null,
    uptime: 0,
    backgroundTime: 0,
  });
  
  // Core managers
  const bleManagerRef = useRef(null);
  const streamClientRef = useRef(null);
  const appStateRef = useRef(AppState.currentState);
  const backgroundStartTime = useRef(null);
  
  useEffect(() => {
    initializeManagers();
    loadSettings();
    
    // App state monitoring for background tracking
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    // Stats update timer
    const statsTimer = setInterval(updateStats, 1000);
    
    return () => {
      subscription?.remove();
      clearInterval(statsTimer);
      cleanup();
    };
  }, []);
  
  const handleAppStateChange = (nextAppState) => {
    if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
      console.log('App came to foreground');
      if (backgroundStartTime.current) {
        const bgTime = Date.now() - backgroundStartTime.current;
        setStats(prev => ({
          ...prev,
          backgroundTime: prev.backgroundTime + bgTime
        }));
        backgroundStartTime.current = null;
      }
    } else if (appStateRef.current === 'active' && nextAppState.match(/inactive|background/)) {
      console.log('App went to background');
      backgroundStartTime.current = Date.now();
    }
    appStateRef.current = nextAppState;
  };
  
  const initializeManagers = async () => {
    // Initialize BLE Manager
    bleManagerRef.current = new BleManager({
      serviceUuid: SERVICE_UUID,
      characteristicUuid: CHARACTERISTIC_UUID,
      onDeviceConnected: (device) => {
        setBleDevice(device);
        Alert.alert('Connected', `Connected to ${device.name}`);
      },
      onDeviceDisconnected: () => {
        setBleDevice(null);
        Alert.alert('Disconnected', 'BLE device disconnected');
      },
      onError: (error) => {
        setStats(prev => ({ ...prev, lastError: error.message }));
      },
    });
    
    // Initialize Stream Client
    streamClientRef.current = new StreamClient({
      onMessage: handleStreamMessage,
      onConnected: () => setStreamConnected(true),
      onDisconnected: () => setStreamConnected(false),
      onError: (error) => {
        setStats(prev => ({ ...prev, lastError: error.message }));
      },
    });
    
    await bleManagerRef.current.initialize();
  };
  
  const handleStreamMessage = async (data) => {
    if (!bleManagerRef.current || !bleManagerRef.current.isConnected()) {
      // Queue message if BLE not connected
      streamClientRef.current.queueMessage(data);
      setStats(prev => ({ ...prev, messagesQueued: prev.messagesQueued + 1 }));
      return
    }
    
    try {
      // Encode message based on protocol selection
      const encoded = useBinaryProtocol 
        ? Protocol.encodeBinary(data)
        : Protocol.encodeJson(data);
      
      // Send via BLE with latency tracking
      const startTime = Date.now();
      await bleManagerRef.current.sendData(encoded);
      const latency = Date.now() - startTime;
      
      // Update stats
      setStats(prev => ({
        ...prev,
        messagesSent: prev.messagesSent + 1,
        avgLatency: prev.avgLatency 
          ? (prev.avgLatency * 0.9 + latency * 0.1) // Exponential moving average
          : latency,
      }));
    } catch (error) {
      console.error('Failed to send BLE message:', error);
      streamClientRef.current.queueMessage(data);
      setStats(prev => ({ ...prev, messagesQueued: prev.messagesQueued + 1 }));
    }
  };
  
  const loadSettings = async () => {
    try {
      const saved = await AsyncStorage.getItem('appSettings');
      if (saved) {
        const settings = JSON.parse(saved);
        setStreamUrl(settings.streamUrl || streamUrl);
        setUseBinaryProtocol(settings.useBinaryProtocol || false);
        setAutoReconnect(settings.autoReconnect !== false);
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  };
  
  const saveSettings = async () => {
    try {
      await AsyncStorage.setItem('appSettings', JSON.stringify({
        streamUrl,
        useBinaryProtocol,
        autoReconnect,
      }));
      Alert.alert('Saved', 'Settings saved successfully');
    } catch (error) {
      Alert.alert('Error', 'Failed to save settings');
    }
  };
  
  const startScanning = async () => {
    setScanning(true);
    setDevices([]);
    
    try {
      await bleManagerRef.current.startScan((device) => {
        if (device.name) {
          setDevices(prev => {
            if (prev.find(d => d.id === device.id)) return prev;
            return [...prev, device];
          });
        }
      });
      
      // Auto-stop after 10 seconds
      setTimeout(() => {
        bleManagerRef.current.stopScan();
        setScanning(false);
      }, 10000);
    } catch (error) {
      Alert.alert('Scan Error', error.message);
      setScanning(false);
    }
  };

  const waitUntil = (pred, { timeoutMs = 5000, intervalMs = 50 } = {}) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (pred()) { clearInterval(t); resolve(); }
        else if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error('timeout')); }
      }, intervalMs);
    });
  
  const drainQueuedMessages = async () => {
    if (!bleManagerRef.current?.isConnected()) return;
    const queued = streamClientRef.current.getQueuedMessages();
    if (!queued.length) return;
    for (const msg of queued) {
      try {
        const encoded = useBinaryProtocol ? Protocol.encodeBinary(msg)
                                          : Protocol.encodeJson(msg);
        await bleManagerRef.current.sendData(encoded);
        setStats(prev => ({ ...prev, messagesSent: prev.messagesSent + 1 }));
      } catch (e) {
        // Put it back if something went wrong
        streamClientRef.current.queueMessage(msg);
        setStats(prev => ({ ...prev, lastError: e.message }));
        break; // stop draining for now
      }
    }
    streamClientRef.current.clearQueue();
  };  
  
  const connectToDevice = async (device) => {
    try {
      bleManagerRef.current.stopScan();
      setScanning(false);
      await bleManagerRef.current.connect(device.id);
      
      // Process queued messages after connection
      await waitUntil(() => bleManagerRef.current?.isConnected(), { timeoutMs: 3000 }).catch(() => {});
      await drainQueuedMessages();
    } catch (error) {
      Alert.alert('Connection Error', error.message);
    }
  };
  
  const disconnect = async () => {
    await bleManagerRef.current.disconnect();
  };
  
  const connectStream = async () => {
    try {
      await streamClientRef.current.connect(streamUrl, {
        autoReconnect,
        reconnectDelay: 1000,
        maxReconnectDelay: 30000,
      });
    } catch (error) {
      Alert.alert('Stream Error', error.message);
    }
  };
  
  const disconnectStream = () => {
    streamClientRef.current.disconnect();
  };
  
  const updateStats = () => {
    setStats(prev => ({ ...prev, uptime: prev.uptime + 1 }));
  };
  
  const cleanup = async () => {
    if (bleManagerRef.current) {
      await bleManagerRef.current.cleanup();
    }
    if (streamClientRef.current) {
      streamClientRef.current.disconnect();
    }
  };
  
  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  };
  
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>BLE Stream Gateway</Text>
        
        {/* Status Overview */}
        <View style={styles.statusCard}>
          <Text style={styles.sectionTitle}>Status</Text>
          <View style={styles.statusRow}>
            <Text>BLE: </Text>
            <Text style={bleDevice ? styles.connected : styles.disconnected}>
              {bleDevice ? `✓ ${bleDevice.name}` : '✗ Disconnected'}
            </Text>
          </View>
          <View style={styles.statusRow}>
            <Text>Stream: </Text>
            <Text style={streamConnected ? styles.connected : styles.disconnected}>
              {streamConnected ? '✓ Connected' : '✗ Disconnected'}
            </Text>
          </View>
        </View>
        
        {/* Statistics */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Statistics</Text>
          <Text style={styles.stat}>Messages Sent: {stats.messagesSent}</Text>
          <Text style={styles.stat}>Messages Queued: {stats.messagesQueued}</Text>
          <Text style={styles.stat}>Avg Latency: {stats.avgLatency.toFixed(1)}ms</Text>
          <Text style={styles.stat}>Uptime: {formatTime(stats.uptime)}</Text>
          <Text style={styles.stat}>Background Time: {formatTime(Math.floor(stats.backgroundTime / 1000))}</Text>
          {stats.lastError && (
            <Text style={styles.error}>Last Error: {stats.lastError}</Text>
          )}
        </View>
        
        {/* BLE Controls */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Bluetooth LE</Text>
          {!bleDevice ? (
            <>
              <TouchableOpacity
                style={[styles.button, scanning && styles.buttonDisabled]}
                onPress={startScanning}
                disabled={scanning}
              >
                {scanning ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Scan for Devices</Text>
                )}
              </TouchableOpacity>
              
              {devices.map(device => (
                <TouchableOpacity
                  key={device.id}
                  style={styles.deviceRow}
                  onPress={() => connectToDevice(device)}
                >
                  <Text style={styles.deviceName}>{device.name}</Text>
                  <Text style={styles.deviceId}>{device.id}</Text>
                </TouchableOpacity>
              ))}
            </>
          ) : (
            <TouchableOpacity
              style={[styles.button, styles.buttonDanger]}
              onPress={disconnect}
            >
              <Text style={styles.buttonText}>Disconnect</Text>
            </TouchableOpacity>
          )}
        </View>
        
        {/* Stream Configuration */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Stream Configuration</Text>
          <TextInput
            style={styles.input}
            placeholder="WebSocket/SSE URL"
            value={streamUrl}
            onChangeText={setStreamUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          
          <View style={styles.switchRow}>
            <Text>Binary Protocol:</Text>
            <Switch
              value={useBinaryProtocol}
              onValueChange={setUseBinaryProtocol}
            />
          </View>
          
          <View style={styles.switchRow}>
            <Text>Auto Reconnect:</Text>
            <Switch
              value={autoReconnect}
              onValueChange={setAutoReconnect}
            />
          </View>
          
          <TouchableOpacity style={styles.button} onPress={saveSettings}>
            <Text style={styles.buttonText}>Save Settings</Text>
          </TouchableOpacity>
          
          {!streamConnected ? (
            <TouchableOpacity
              style={[styles.button, styles.buttonSuccess]}
              onPress={connectStream}
            >
              <Text style={styles.buttonText}>Connect Stream</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.button, styles.buttonDanger]}
              onPress={disconnectStream}
            >
              <Text style={styles.buttonText}>Disconnect Stream</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollContent: {
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  statusCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  statusRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  connected: {
    color: '#4caf50',
    fontWeight: '600',
  },
  disconnected: {
    color: '#f44336',
    fontWeight: '600',
  },
  stat: {
    fontSize: 14,
    marginBottom: 4,
    color: '#333',
  },
  error: {
    fontSize: 12,
    color: '#f44336',
    marginTop: 8,
  },
  button: {
    backgroundColor: '#2196f3',
    padding: 12,
    borderRadius: 6,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonSuccess: {
    backgroundColor: '#4caf50',
  },
  buttonDanger: {
    backgroundColor: '#f44336',
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
    marginBottom: 12,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  deviceRow: {
    padding: 12,
    backgroundColor: '#f9f9f9',
    borderRadius: 6,
    marginTop: 8,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
  },
  deviceId: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
});
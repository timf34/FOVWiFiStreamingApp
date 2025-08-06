import { BleManager as PlxBleManager } from 'react-native-ble-plx';
import { PermissionsAndroid, Platform, Alert } from 'react-native';
import base64 from 'base-64';

export class BleManager {
  constructor(config) {
    this.manager = new PlxBleManager();
    this.serviceUuid = config.serviceUuid;
    this.characteristicUuid = config.characteristicUuid;
    this.onDeviceConnected = config.onDeviceConnected || (() => {});
    this.onDeviceDisconnected = config.onDeviceDisconnected || (() => {});
    this.onError = config.onError || (() => {});
    
    this.connectedDevice = null;
    this.subscription = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.isReconnecting = false;
    this.lastDeviceId = null;
    
    // Monitor BLE state changes
    this.stateSubscription = this.manager.onStateChange((state) => {
      console.log('[BLE] State changed to:', state);
      if (state === 'PoweredOn' && this.isReconnecting && this.lastDeviceId) {
        this.reconnect();
      }
    }, true);
  }
  
  async initialize() {
    // Request permissions on Android
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      
      const allGranted = Object.values(granted).every(
        res => res === PermissionsAndroid.RESULTS.GRANTED
      );
      
      if (!allGranted) {
        throw new Error('Bluetooth permissions are required');
      }
    }
    
    // Wait for BLE to be ready
    const state = await this.manager.state();
    if (state !== 'PoweredOn') {
      await new Promise((resolve) => {
        const sub = this.manager.onStateChange((state) => {
          if (state === 'PoweredOn') {
            sub.remove();
            resolve();
          }
        }, true);
      });
    }
  }
  
  async startScan(onDeviceFound, serviceUUIDs = null) {
    return new Promise((resolve, reject) => {
      this.manager.startDeviceScan(
        serviceUUIDs,
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            this.onError(error);
            reject(error);
            return;
          }
          
          if (device && device.name) {
            onDeviceFound({
              id: device.id,
              name: device.name,
              rssi: device.rssi,
            });
          }
        }
      );
      resolve();
    });
  }
  
  stopScan() {
    this.manager.stopDeviceScan();
  }
  
  async connect(deviceId, retryCount = 0) {
    try {
      // Stop any ongoing scan
      this.stopScan();
      
      // Store device ID for reconnection
      this.lastDeviceId = deviceId;
      this.isReconnecting = false;
      
      // Connect with timeout
      console.log('[BLE] Connecting to device:', deviceId);
      const device = await this.manager.connectToDevice(deviceId, {
        requestMTU: 512, // Request larger MTU for better throughput
        timeout: 10000,
      });
      
      // Discover services and characteristics
      await device.discoverAllServicesAndCharacteristics();
      
      // Verify our service exists
      const services = await device.services();
      const service = services.find(s => s.uuid === this.serviceUuid);
      if (!service) {
        throw new Error('Required service not found on device');
      }
      
      // Setup notification subscription for bidirectional communication
      this.subscription = await device.monitorCharacteristicForService(
        this.serviceUuid,
        this.characteristicUuid,
        this.handleNotification.bind(this)
      );
      
      // Setup disconnection handler
      device.onDisconnected((error) => {
        console.log('[BLE] Device disconnected:', error?.message || 'No error');
        this.handleDisconnection();
      });
      
      this.connectedDevice = device;
      this.reconnectAttempts = 0;
      this.onDeviceConnected(device);
      
      console.log('[BLE] Successfully connected to:', device.name);
      return device;
      
    } catch (error) {
      console.error('[BLE] Connection failed:', error);
      
      // Implement exponential backoff for reconnection
      if (retryCount < this.maxReconnectAttempts) {
        const delay = Math.min(this.reconnectDelay * Math.pow(2, retryCount), 30000);
        console.log(`[BLE] Retrying connection in ${delay}ms (attempt ${retryCount + 1})`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.connect(deviceId, retryCount + 1);
      }
      
      this.onError(error);
      throw error;
    }
  }
  
  async disconnect() {
    this.isReconnecting = false;
    this.lastDeviceId = null;
    
    if (this.subscription) {
      this.subscription.remove();
      this.subscription = null;
    }
    
    if (this.connectedDevice) {
      try {
        await this.manager.cancelDeviceConnection(this.connectedDevice.id);
      } catch (error) {
        console.error('[BLE] Error during disconnect:', error);
      }
      this.connectedDevice = null;
    }
  }
  
  async sendData(data) {
    if (!this.connectedDevice) {
      throw new Error('No device connected');
    }
    
    try {
      // Encode data to base64
      const encoded = typeof data === 'string' 
        ? base64.encode(data)
        : base64.encode(String.fromCharCode.apply(null, new Uint8Array(data)));
      
      // Write with response for reliability
      await this.connectedDevice.writeCharacteristicWithResponseForService(
        this.serviceUuid,
        this.characteristicUuid,
        encoded
      );
      
      return true;
    } catch (error) {
      console.error('[BLE] Failed to send data:', error);
      
      // Check if device is still connected
      const isConnected = await this.connectedDevice.isConnected();
      if (!isConnected) {
        this.handleDisconnection();
      }
      
      throw error;
    }
  }
  
  async sendDataWithoutResponse(data) {
    // For high-frequency updates where occasional loss is acceptable
    if (!this.connectedDevice) {
      throw new Error('No device connected');
    }
    
    try {
      const encoded = typeof data === 'string' 
        ? base64.encode(data)
        : base64.encode(String.fromCharCode.apply(null, new Uint8Array(data)));
      
      await this.connectedDevice.writeCharacteristicWithoutResponseForService(
        this.serviceUuid,
        this.characteristicUuid,
        encoded
      );
      
      return true;
    } catch (error) {
      console.error('[BLE] Failed to send data without response:', error);
      throw error;
    }
  }
  
  handleNotification(error, characteristic) {
    if (error) {
      console.error('[BLE] Notification error:', error);
      this.onError(error);
      return;
    }
    
    if (!characteristic?.value) return;
    
    try {
      const decoded = base64.decode(characteristic.value);
      console.log('[BLE] Notification received:', decoded);
      
      // Handle ESP32 responses/acknowledgments here
      // Could be used for latency measurement or flow control
    } catch (err) {
      console.error('[BLE] Error decoding notification:', err);
    }
  }
  
  handleDisconnection() {
    this.connectedDevice = null;
    
    if (this.subscription) {
      this.subscription.remove();
      this.subscription = null;
    }
    
    this.onDeviceDisconnected();
    
    // Auto-reconnect if we have a last device ID
    if (this.lastDeviceId && !this.isReconnecting) {
      this.isReconnecting = true;
      this.reconnect();
    }
  }
  
  async reconnect() {
    if (!this.lastDeviceId || !this.isReconnecting) return;
    
    console.log('[BLE] Attempting to reconnect...');
    
    try {
      await this.connect(this.lastDeviceId);
      this.isReconnecting = false;
    } catch (error) {
      console.error('[BLE] Reconnection failed:', error);
      
      // Schedule another reconnection attempt
      if (this.isReconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
        setTimeout(() => this.reconnect(), delay);
      } else {
        this.isReconnecting = false;
        this.lastDeviceId = null;
      }
    }
  }
  
  async cleanup() {
    this.isReconnecting = false;
    
    if (this.stateSubscription) {
      this.stateSubscription.remove();
    }
    
    await this.disconnect();
    this.manager.destroy();
  }
  
  isConnected() {
    return this.connectedDevice !== null;
  }
  
  getConnectedDevice() {
    return this.connectedDevice;
  }
}
import EventSource from 'react-native-sse';

export class StreamClient {
  constructor(config) {
    this.onMessage = config.onMessage || (() => {});
    this.onConnected = config.onConnected || (() => {});
    this.onDisconnected = config.onDisconnected || (() => {});
    this.onError = config.onError || (() => {});
    
    this.connection = null;
    this.messageQueue = [];
    this.isConnected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.config = null;
    this.url = null;
    this.connectionType = null; // 'websocket' or 'sse'
    
    // Performance tracking
    this.lastMessageTime = Date.now();
    this.messageRate = 0;
    this.messageRateTimer = null;
    this.messageCount = 0;
  }
  
  async connect(url, config = {}) {
    this.url = url;
    this.config = {
      autoReconnect: true,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      maxReconnectAttempts: Infinity,
      ...config,
    };
    
    // Determine connection type from URL
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
      this.connectionType = 'websocket';
      return this.connectWebSocket(url);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      this.connectionType = 'sse';
      return this.connectSSE(url);
    } else {
      throw new Error('Invalid URL scheme. Use ws://, wss://, http://, or https://');
    }
  }
  
  async connectWebSocket(url) {
    return new Promise((resolve, reject) => {
      try {
        console.log('[Stream] Connecting WebSocket to:', url);
        
        this.connection = new WebSocket(url);
        
        this.connection.onopen = () => {
          console.log('[Stream] WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.onConnected();
          this.startMessageRateTracking();
          resolve();
        };
        
        this.connection.onmessage = (event) => {
          this.handleMessage(event.data);
        };
        
        this.connection.onerror = (error) => {
          console.error('[Stream] WebSocket error:', error);
          this.onError(error);
          if (!this.isConnected) {
            reject(error);
          }
        };
        
        this.connection.onclose = (event) => {
          console.log('[Stream] WebSocket closed:', event.code, event.reason);
          this.handleDisconnection();
        };
        
      } catch (error) {
        console.error('[Stream] Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }
  
  async connectSSE(url) {
    return new Promise((resolve, reject) => {
      try {
        console.log('[Stream] Connecting SSE to:', url);
        
        this.connection = new EventSource(url, {
          headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
        
        this.connection.addEventListener('open', () => {
          console.log('[Stream] SSE connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.onConnected();
          this.startMessageRateTracking();
          resolve();
        });
        
        this.connection.addEventListener('message', (event) => {
          this.handleMessage(event.data);
        });
        
        this.connection.addEventListener('error', (error) => {
          console.error('[Stream] SSE error:', error);
          this.onError(error);
          if (!this.isConnected) {
            reject(error);
          }
          this.handleDisconnection();
        });
        
      } catch (error) {
        console.error('[Stream] Failed to create SSE connection:', error);
        reject(error);
      }
    });
  }
  
  handleMessage(data) {
    try {
      // Update message rate tracking
      this.messageCount++;
      this.lastMessageTime = Date.now();
      
      // Parse message if it's JSON
      let parsedData = data;
      try {
        parsedData = JSON.parse(data);
      } catch {
        // Not JSON, use as-is
      }
      
      // Call message handler
      this.onMessage(parsedData);
      
    } catch (error) {
      console.error('[Stream] Error handling message:', error);
      this.onError(error);
    }
  }
  
  handleDisconnection() {
    this.isConnected = false;
    this.stopMessageRateTracking();
    this.onDisconnected();
    
    // Clear existing connection
    if (this.connection) {
      if (this.connectionType === 'websocket') {
        this.connection.close();
      } else if (this.connectionType === 'sse') {
        this.connection.close();
      }
      this.connection = null;
    }
    
    // Auto-reconnect if configured
    if (this.config?.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }
  
  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectDelay
    );
    
    console.log(`[Stream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect(this.url, this.config).catch(error => {
        console.error('[Stream] Reconnection failed:', error);
      });
    }, delay);
  }
  
  disconnect() {
    console.log('[Stream] Disconnecting...');
    
    // Cancel reconnection
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Disable auto-reconnect
    if (this.config) {
      this.config.autoReconnect = false;
    }
    
    // Close connection
    if (this.connection) {
      if (this.connectionType === 'websocket' && this.connection.readyState === WebSocket.OPEN) {
        this.connection.close(1000, 'User disconnect');
      } else if (this.connectionType === 'sse') {
        this.connection.close();
      }
      this.connection = null;
    }
    
    this.isConnected = false;
    this.stopMessageRateTracking();
    this.onDisconnected();
  }
  
  send(data) {
    // Only for WebSocket connections
    if (this.connectionType !== 'websocket') {
      console.warn('[Stream] Cannot send data over SSE connection');
      return false;
    }
    
    if (!this.isConnected || !this.connection) {
      console.warn('[Stream] Cannot send - not connected');
      return false;
    }
    
    try {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      this.connection.send(message);
      return true;
    } catch (error) {
      console.error('[Stream] Failed to send message:', error);
      this.onError(error);
      return false;
    }
  }
  
  // Message queue management for offline/disconnected periods
  queueMessage(message) {
    // Limit queue size to prevent memory issues
    const MAX_QUEUE_SIZE = 1000;
    
    if (this.messageQueue.length >= MAX_QUEUE_SIZE) {
      // Remove oldest message
      this.messageQueue.shift();
    }
    
    this.messageQueue.push({
      data: message,
      timestamp: Date.now(),
    });
  }
  
  getQueuedMessages() {
    return this.messageQueue.map(m => m.data);
  }
  
  clearQueue() {
    this.messageQueue = [];
  }
  
  getQueueSize() {
    return this.messageQueue.length;
  }
  
  // Performance monitoring
  startMessageRateTracking() {
    this.messageCount = 0;
    this.messageRateTimer = setInterval(() => {
      this.messageRate = this.messageCount;
      this.messageCount = 0;
    }, 1000);
  }
  
  stopMessageRateTracking() {
    if (this.messageRateTimer) {
      clearInterval(this.messageRateTimer);
      this.messageRateTimer = null;
    }
    this.messageRate = 0;
  }
  
  getMessageRate() {
    return this.messageRate;
  }
  
  getConnectionStatus() {
    return {
      connected: this.isConnected,
      type: this.connectionType,
      reconnectAttempts: this.reconnectAttempts,
      messageRate: this.messageRate,
      queueSize: this.messageQueue.length,
    };
  }
}
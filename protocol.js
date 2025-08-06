export class Protocol {
	// JSON protocol - human readable but larger
	static encodeJson(data) {
	  const message = {
		t: Date.now(), // timestamp
		d: data,       // data payload
	  };
	  return JSON.stringify(message) + '\n';
	}
	
	static decodeJson(str) {
	  try {
		const message = JSON.parse(str.trim());
		return {
		  timestamp: message.t,
		  data: message.d,
		};
	  } catch (error) {
		console.error('[Protocol] Failed to decode JSON:', error);
		return null;
	  }
	}
	
	// Binary protocol - compact for high-frequency updates
	static encodeBinary(data) {
	  // Protocol format:
	  // [1 byte: message type][4 bytes: timestamp][variable: payload]
	  
	  let payload;
	  let messageType;
	  
	  // Determine message type and encode payload
	  if (typeof data === 'object' && data.x !== undefined && data.y !== undefined) {
		// Coordinate data - most common case
		messageType = 0x01;
		payload = this.encodeCoordinates(data.x, data.y, data.z);
	  } else if (typeof data === 'string') {
		// String message
		messageType = 0x02;
		payload = this.encodeString(data);
	  } else if (typeof data === 'object') {
		// Generic object - fallback to JSON
		messageType = 0x03;
		payload = this.encodeString(JSON.stringify(data));
	  } else {
		// Unknown type
		messageType = 0xFF;
		payload = new Uint8Array(0);
	  }
	  
	  // Create binary message
	  const timestamp = Date.now();
	  const buffer = new ArrayBuffer(1 + 4 + payload.length);
	  const view = new DataView(buffer);
	  const bytes = new Uint8Array(buffer);
	  
	  // Write header
	  view.setUint8(0, messageType);
	  view.setUint32(1, timestamp & 0xFFFFFFFF, true); // Little-endian
	  
	  // Write payload
	  bytes.set(payload, 5);
	  
	  return buffer;
	}
	
	static decodeBinary(buffer) {
	  if (buffer.byteLength < 5) {
		console.error('[Protocol] Binary message too short');
		return null;
	  }
	  
	  const view = new DataView(buffer);
	  const messageType = view.getUint8(0);
	  const timestamp = view.getUint32(1, true);
	  
	  const payloadStart = 5;
	  const payloadLength = buffer.byteLength - payloadStart;
	  const payload = new Uint8Array(buffer, payloadStart, payloadLength);
	  
	  let data;
	  
	  switch (messageType) {
		case 0x01: // Coordinates
		  data = this.decodeCoordinates(payload);
		  break;
		case 0x02: // String
		case 0x03: // JSON object as string
		  const str = this.decodeString(payload);
		  if (messageType === 0x03) {
			try {
			  data = JSON.parse(str);
			} catch {
			  data = str;
			}
		  } else {
			data = str;
		  }
		  break;
		default:
		  data = payload;
	  }
	  
	  return {
		type: messageType,
		timestamp,
		data,
	  };
	}
	
	// Helper functions for binary encoding
	static encodeCoordinates(x, y, z = 0) {
	  // Use 16-bit integers for coordinates (range: -32768 to 32767)
	  // Scale floating point to fixed point with 2 decimal places
	  const buffer = new ArrayBuffer(6);
	  const view = new DataView(buffer);
	  
	  view.setInt16(0, Math.round(x * 100), true);
	  view.setInt16(2, Math.round(y * 100), true);
	  view.setInt16(4, Math.round(z * 100), true);
	  
	  return new Uint8Array(buffer);
	}
	
	static decodeCoordinates(bytes) {
	  if (bytes.length < 6) {
		return { x: 0, y: 0, z: 0 };
	  }
	  
	  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	  
	  return {
		x: view.getInt16(0, true) / 100,
		y: view.getInt16(2, true) / 100,
		z: view.getInt16(4, true) / 100,
	  };
	}
	
	static encodeString(str) {
	  const encoder = new TextEncoder();
	  return encoder.encode(str);
	}
	
	static decodeString(bytes) {
	  const decoder = new TextDecoder();
	  return decoder.decode(bytes);
	}
	
	// Utility functions for message batching
	static createBatch(messages, useBinary = false) {
	  if (useBinary) {
		// Binary batch format:
		// [2 bytes: message count][message1][message2]...
		
		const encodedMessages = messages.map(msg => this.encodeBinary(msg));
		const totalLength = encodedMessages.reduce((sum, msg) => sum + msg.byteLength + 2, 2);
		
		const buffer = new ArrayBuffer(totalLength);
		const view = new DataView(buffer);
		const bytes = new Uint8Array(buffer);
		
		// Write message count
		view.setUint16(0, messages.length, true);
		
		// Write messages with length prefixes
		let offset = 2;
		for (const msg of encodedMessages) {
		  const msgBytes = new Uint8Array(msg);
		  view.setUint16(offset, msgBytes.length, true);
		  bytes.set(msgBytes, offset + 2);
		  offset += msgBytes.length + 2;
		}
		
		return buffer;
	  } else {
		// JSON batch - newline delimited
		return messages.map(msg => this.encodeJson(msg)).join('');
	  }
	}
	
	static parseBatch(data, isBinary = false) {
	  if (isBinary) {
		const buffer = data instanceof ArrayBuffer ? data : data.buffer;
		const view = new DataView(buffer);
		
		const messageCount = view.getUint16(0, true);
		const messages = [];
		
		let offset = 2;
		for (let i = 0; i < messageCount; i++) {
		  const msgLength = view.getUint16(offset, true);
		  offset += 2;
		  
		  const msgBuffer = buffer.slice(offset, offset + msgLength);
		  const decoded = this.decodeBinary(msgBuffer);
		  if (decoded) {
			messages.push(decoded);
		  }
		  
		  offset += msgLength;
		}
		
		return messages;
	  } else {
		// JSON batch - newline delimited
		return data.split('\n')
		  .filter(line => line.trim())
		  .map(line => this.decodeJson(line))
		  .filter(msg => msg !== null);
	  }
	}
	
	// Message validation
	static validateMessage(data) {
	  if (!data) return false;
	  
	  // Add your validation rules here
	  if (typeof data === 'object' && data.x !== undefined && data.y !== undefined) {
		// Validate coordinate bounds
		return typeof data.x === 'number' && typeof data.y === 'number' &&
			   Math.abs(data.x) <= 32767 && Math.abs(data.y) <= 32767;
	  }
	  
	  return true;
	}
  }
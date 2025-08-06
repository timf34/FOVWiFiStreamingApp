// app.config.js
import { ExpoConfig } from 'expo/config';

// Import the configuration from app.json
import appJson from './app.json';

// Export the configuration
const config = appJson.expo;

export default config; 
// AppEntry.js - Alternative entry point for the app

import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';
import App from './App';

// Register the app component
console.log('AppEntry.js: Registering app component');
AppRegistry.registerComponent('main', () => App);

// Also use Expo's registerRootComponent for maximum compatibility
registerRootComponent(App);

// Export the App component as default
export default App; 
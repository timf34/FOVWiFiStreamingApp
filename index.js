// index.js - Main entry point for the app
import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';
import App from './App';

console.log('index.js: Registering app component');

// Make sure to register the app with both methods for maximum compatibility
AppRegistry.registerComponent('main', () => App);

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

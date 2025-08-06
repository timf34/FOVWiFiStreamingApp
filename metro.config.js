const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add any custom configuration here
config.resolver.sourceExts = ['js', 'jsx', 'json', 'ts', 'tsx'];

// Ensure the entry file is properly resolved
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];

module.exports = config; 
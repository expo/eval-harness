module.exports = ({ config }) => ({
  ...config,
  ios: { ...config.ios, supportsTablet: false },
  extra: { ...config.extra, apiUrl: process.env.EXPO_PUBLIC_API_URL || "https://api.example.test" },
});

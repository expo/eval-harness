module.exports = ({ config }) => ({
  name: config.name,
  slug: config.slug,
  ios: { supportsTablet: false },
  extra: { apiUrl: process.env.EXPO_PUBLIC_API_URL },
});

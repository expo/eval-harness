const DEFAULT_PROJECT_ID = "338f6455-57a3-49c9-a2e0-36e5a0577c77";
const DEFAULT_SLUG = "adi-test-project";

module.exports = ({ config }) => {
  const owner = process.env.EXPO_OWNER || config.owner;

  return {
    ...config,
    name: process.env.EXPO_APP_NAME || config.name || "eval-harness",
    slug: process.env.EXPO_SLUG || DEFAULT_SLUG,
    owner,
    version: config.version || "1.0.0",
    platforms: config.platforms || ["ios", "android"],
    extra: {
      ...(config.extra || {}),
      eas: {
        ...((config.extra || {}).eas || {}),
        projectId: process.env.EAS_PROJECT_ID || ((config.extra || {}).eas || {}).projectId || DEFAULT_PROJECT_ID,
      },
    },
  };
};

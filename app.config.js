// No committed EAS project identity.
// Set EAS_PROJECT_ID / EXPO_SLUG / EXPO_OWNER (see .env.default), or let
// `eas init` write extra.eas.projectId.
module.exports = ({ config }) => {
  const extra = config.extra || {};
  const eas = extra.eas || {};
  const projectId = process.env.EAS_PROJECT_ID || eas.projectId;
  const owner = process.env.EXPO_OWNER || config.owner;

  return {
    ...config,
    name: process.env.EXPO_APP_NAME || config.name || "eval-harness",
    slug: process.env.EXPO_SLUG || config.slug || "eval-harness",
    ...(owner ? { owner } : {}),
    version: config.version || "1.0.0",
    platforms: config.platforms || ["ios", "android"],
    extra: {
      ...extra,
      eas: {
        ...eas,
        ...(projectId ? { projectId } : {}),
      },
    },
  };
};

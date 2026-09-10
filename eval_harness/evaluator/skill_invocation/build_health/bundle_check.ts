// Compatibility import; implementation lives in the published package.
export * from "@expo/skill-analyzer/build_health/bundle_check";
import { main } from "@expo/skill-analyzer/build_health/bundle_check";
if (import.meta.main) process.exitCode = main();

export * from "@expo/skill-analyzer/artifacts";
import { runMaterializeCli } from "@expo/skill-analyzer/artifacts";
if (import.meta.main) process.exitCode = runMaterializeCli(process.argv.slice(2));

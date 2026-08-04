// Importing the package registers code-driven checks before callers resolve
// the combined registry, matching uptake_checks/__init__.py on the Python side.
import "./code_checks.ts";

export * from "./registry.ts";

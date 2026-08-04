// Keep a package-facing entrypoint while registry.ts makes code-check
// registration unavoidable even for callers that import the registry directly.
export * from "./registry.ts";

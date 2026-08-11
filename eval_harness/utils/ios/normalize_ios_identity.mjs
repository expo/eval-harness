#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [workspace, runId, resolvedConfigPath, adjustmentPath] = process.argv.slice(2);

if (!workspace || !runId || !resolvedConfigPath || !adjustmentPath) {
  console.error(
    "usage: normalize_ios_identity.mjs <workspace> <run-id> <resolved-expo-config.json> <adjustments.json>",
  );
  process.exit(2);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hasValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0;
}

function dynamicConfig(workspacePath) {
  for (const extension of ["ts", "mts", "cts", "mjs", "cjs", "js"]) {
    const candidate = path.join(workspacePath, `app.config.${extension}`);
    if (fs.existsSync(candidate)) return { path: candidate, extension };
  }
  return null;
}

function identityFor(run) {
  const digest = createHash("sha256").update(run).digest("hex").slice(0, 12);
  return {
    bundleIdentifier: `com.evalharness.${digest}`,
    scheme: `eval-${digest}`,
  };
}

function wrapperSource(extension, backupName, backupPath, identity, packageType) {
  const normalize = `const evaluatorIdentity = ${JSON.stringify(identity)};
const missing = (value) => typeof value === "string" ? value.trim().length === 0 : !Array.isArray(value) || value.length === 0;
const withEvaluatorIdentity = (value) => {
  const config = value && typeof value === "object" ? value : {};
  const hasExpoEnvelope = config.expo && typeof config.expo === "object";
  const expo = hasExpoEnvelope ? config.expo : config;
  const normalized = {
    ...expo,
    scheme: missing(expo.scheme) ? evaluatorIdentity.scheme : expo.scheme,
    ios: {
      ...(expo.ios && typeof expo.ios === "object" ? expo.ios : {}),
      bundleIdentifier: missing(expo.ios && expo.ios.bundleIdentifier)
        ? evaluatorIdentity.bundleIdentifier
        : expo.ios.bundleIdentifier,
    },
  };
  return hasExpoEnvelope ? { ...config, expo: normalized } : normalized;
};`;
  const esm = ["mjs", "mts"].includes(extension) || (extension === "js" && packageType === "module");
  if (esm) {
    return `import authoredConfig from "./${backupName}";
${normalize}
export default (context) => withEvaluatorIdentity(
  typeof authoredConfig === "function" ? authoredConfig(context) : authoredConfig,
);
`;
  }
  return `const { loadModuleSync } = require("@expo/require-utils");
const authoredModule = loadModuleSync(${JSON.stringify(backupPath)});
const authoredConfig = authoredModule.default ?? authoredModule;
${normalize}
module.exports = (context) => withEvaluatorIdentity(
  typeof authoredConfig === "function" ? authoredConfig(context) : authoredConfig,
);
`;
}

function replaceDynamicConfig(config, identity, packageType) {
  const sourceName = path.basename(config.path);
  const backupName = `.eval-ios-author-${sourceName}`;
  const backupPath = path.join(path.dirname(config.path), backupName);
  if (fs.existsSync(backupPath)) {
    throw new Error(`refusing to overwrite existing evaluator config backup: ${backupName}`);
  }
  fs.renameSync(config.path, backupPath);
  try {
    fs.writeFileSync(
      config.path,
      wrapperSource(config.extension, backupName, backupPath, identity, packageType),
      "utf8",
    );
  } catch (error) {
    fs.renameSync(backupPath, config.path);
    throw error;
  }
  return sourceName;
}

function patchStaticConfig(workspacePath, resolved, identity) {
  const appJsonPath = path.join(workspacePath, "app.json");
  const document = fs.existsSync(appJsonPath) ? readJson(appJsonPath) : { expo: resolved };
  const expo = document.expo && typeof document.expo === "object" ? document.expo : {};
  if (!hasValue(expo.scheme)) expo.scheme = identity.scheme;
  const ios = expo.ios && typeof expo.ios === "object" ? expo.ios : {};
  if (!hasValue(ios.bundleIdentifier)) ios.bundleIdentifier = identity.bundleIdentifier;
  expo.ios = ios;
  document.expo = expo;
  writeJson(appJsonPath, document);
  return "app.json";
}

let resolved;
try {
  resolved = readJson(resolvedConfigPath);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new Error("resolved Expo config must be an object");
  }
} catch (error) {
  console.error(`could not read resolved Expo config: ${error.message}`);
  process.exit(1);
}

const evaluatorIdentity = identityFor(runId);
const ios = resolved.ios && typeof resolved.ios === "object" ? resolved.ios : {};
const adjustments = [];
if (!hasValue(ios.bundleIdentifier)) {
  adjustments.push({ field: "ios.bundleIdentifier", from: ios.bundleIdentifier ?? null, to: evaluatorIdentity.bundleIdentifier });
}
if (!hasValue(resolved.scheme)) {
  adjustments.push({ field: "scheme", from: resolved.scheme ?? null, to: evaluatorIdentity.scheme });
}

let configPath = null;
let configKind = null;
if (adjustments.length > 0) {
  const dynamic = dynamicConfig(workspace);
  if (dynamic) {
    let packageType = null;
    const packagePath = path.join(workspace, "package.json");
    if (fs.existsSync(packagePath)) {
      try {
        packageType = readJson(packagePath).type;
      } catch {
        packageType = null;
      }
    }
    configPath = replaceDynamicConfig(dynamic, evaluatorIdentity, packageType);
    configKind = "dynamic";
  } else {
    configPath = patchStaticConfig(workspace, resolved, evaluatorIdentity);
    configKind = "static";
  }
}

writeJson(adjustmentPath, {
  schema_version: 1,
  source: "evaluator",
  run_id: runId,
  adjustments,
  config_kind: configKind,
  config_path: configPath,
});
process.stdout.write(`${JSON.stringify({ adjustments, config_kind: configKind, config_path: configPath })}\n`);

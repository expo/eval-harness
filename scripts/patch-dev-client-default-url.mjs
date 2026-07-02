#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const workspace = process.argv[2];
const defaultLaunchURL = process.argv[3] || "http://localhost:8081";

if (!workspace) {
  console.error("usage: patch-dev-client-default-url.mjs <workspace> [defaultLaunchURL]");
  process.exit(2);
}

const appJsonPath = path.join(workspace, "app.json");
const appConfigJsPath = path.join(workspace, "app.config.js");
const appConfigTsPath = path.join(workspace, "app.config.ts");

if (!fs.existsSync(appJsonPath)) {
  const dynamic = [appConfigJsPath, appConfigTsPath].filter((p) => fs.existsSync(p));
  if (dynamic.length) {
    console.log(
      `  ⚠️  dynamic Expo config present (${dynamic.map(path.basename).join(", ")}); ` +
        "skipping app.json dev-client plugin patch"
    );
  } else {
    console.log("  ⚠️  no app.json found; skipping dev-client plugin patch");
  }
  process.exit(0);
}

const raw = fs.readFileSync(appJsonPath, "utf8");
const data = JSON.parse(raw);
data.expo = data.expo || {};
const expo = data.expo;
expo.plugins = Array.isArray(expo.plugins) ? expo.plugins : [];

const desired = {
  launchMode: "most-recent",
  defaultLaunchURL,
  ios: {
    launchMode: "most-recent",
    defaultLaunchURL,
  },
};

let patched = false;
expo.plugins = expo.plugins.map((plugin) => {
  const name = Array.isArray(plugin) ? plugin[0] : plugin;
  if (name !== "expo-dev-client") {
    return plugin;
  }
  const existing = Array.isArray(plugin) && plugin[1] && typeof plugin[1] === "object"
    ? plugin[1]
    : {};
  patched = true;
  return [
    "expo-dev-client",
    {
      ...existing,
      ...desired,
      ios: {
        ...(existing.ios || {}),
        ...desired.ios,
      },
    },
  ];
});

if (!patched) {
  expo.plugins.push(["expo-dev-client", desired]);
}

fs.writeFileSync(appJsonPath, `${JSON.stringify(data, null, 2)}\n`);
console.log(`  configured expo-dev-client defaultLaunchURL=${defaultLaunchURL}`);

import { basename, extname, join, relative } from "node:path";

import {
  extractAstFacts,
  type AstFacts,
} from "../build_health/node_parser.ts";
import {
  STATUS_FAILED,
  STATUS_NOT_APPLICABLE,
  STATUS_PASSED,
  STATUS_UNAVAILABLE,
  AppTree,
  CheckResult,
  register,
  stripComments,
} from "./registry.ts";

const USE_DOM_CANDIDATE = /['"]use dom['"]/u;
const LAYOUT_FILENAME = /^_layout\.(t|j)sx?$/u;
const API_ROUTE_FILENAME = /\+api\.(t|j)sx?$/u;
const BANNED_NODE_IMPORT = /from\s+['"](fs|node:fs|node:crypto|node-fetch)['"]|require\(['"](fs|node:fs|node:crypto|node-fetch)['"]\)/u;
const PROCESS_ENV_READ = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu;
const ENV_PREFIX_EXEMPT = new Set(["NODE_ENV", "EXPO_OS"]);

const EXPO_UI_IMPORTS = [
  /from\s*['"]@expo\/ui['"]/u,
  /from\s*['"]@expo\/ui\/swift-ui['"]/u,
  /from\s*['"]@expo\/ui\/jetpack-compose['"]/u,
  /from\s*['"]@expo\/ui\/community\//u,
];
const EXPO_UI_HOST_FROM_SUBPACKAGE = /\bHost\b[^\n]*from\s*['"]@expo\/ui\/(swift-ui|jetpack-compose)['"]/u;
const EXPO_UI_PLATFORM_TREE_GLOBS = [
  "app/**/*.ios.tsx",
  "app/**/*.android.tsx",
  "src/app/**/*.ios.tsx",
  "src/app/**/*.android.tsx",
];
const FETCH_OR_QUERY_LIBS = [
  /fetch\(/u,
  /from\s*['"]@tanstack\/react-query['"]/u,
  /from\s*['"]swr['"]/u,
];
const AXIOS_IMPORT = /from\s*['"]axios['"]/u;
const EXPO_AV_IMPORT = /from\s*['"]expo-av['"]/u;
const EXPO_AUDIO_OR_VIDEO_IMPORTS = [
  /from\s*['"]expo-audio['"]/u,
  /from\s*['"]expo-video['"]/u,
];
const DIMENSIONS_GET = /Dimensions\.get\(/u;
const USE_WINDOW_DIMENSIONS = /useWindowDimensions\(/u;
const SAFE_AREA_VIEW_FROM_REACT_NATIVE = /import\s*\{[^}]*\bSafeAreaView\b[^}]*\}\s*from\s*['"]react-native['"]/u;
const SAFE_AREA_CONTEXT_IMPORT = /from\s*['"]react-native-safe-area-context['"]/u;
const EXPO_ROUTER_IMPORT = /from\s*['"]expo-router['"]|require\(['"]expo-router['"]\)/u;
const REACT_NAVIGATION_IMPORT = /from\s*['"]@react-navigation\//u;

function passed(checkId: string, category: string, evidence: string): CheckResult {
  return new CheckResult({
    id: checkId,
    category,
    kind: "code",
    target: null,
    passed: true,
    evidence,
    status: STATUS_PASSED,
  });
}

function failed(checkId: string, category: string, evidence: string): CheckResult {
  return new CheckResult({
    id: checkId,
    category,
    kind: "code",
    target: null,
    passed: false,
    evidence,
    status: STATUS_FAILED,
  });
}

function notApplicable(
  checkId: string,
  category: string,
  evidence: string,
): CheckResult {
  return new CheckResult({
    id: checkId,
    category,
    kind: "code",
    target: null,
    passed: null,
    evidence,
    status: STATUS_NOT_APPLICABLE,
  });
}

function unavailable(
  checkId: string,
  category: string,
  evidence: string,
): CheckResult {
  return new CheckResult({
    id: checkId,
    category,
    kind: "code",
    target: null,
    passed: null,
    evidence,
    status: STATUS_UNAVAILABLE,
  });
}

function expoUiImported(appTree: AppTree): boolean {
  return [...appTree.files.values()].some((text) =>
    EXPO_UI_IMPORTS.some((pattern) => pattern.test(stripComments(text)))
  );
}

type DomCandidates = {
  confirmed: Array<[string, AstFacts]>;
  unavailablePaths: Set<string>;
};

function domCandidateFiles(appTree: AppTree): DomCandidates {
  const candidatePaths = [...appTree.files]
    .filter(([, text]) => USE_DOM_CANDIDATE.test(stripComments(text)))
    .map(([path]) => path);
  const confirmed: Array<[string, AstFacts]> = [];
  const unavailablePaths = new Set<string>();
  for (const path of candidatePaths) {
    const facts = extractAstFacts(join(appTree.root, path));
    if ("error" in facts) {
      unavailablePaths.add(path);
      continue;
    }
    if (facts.hasUseDomDirective) confirmed.push([path, facts]);
  }
  return { confirmed, unavailablePaths };
}

register("dom_use_dom_directive_present", "syntax-tree")((appTree) => {
  const { confirmed, unavailablePaths } = domCandidateFiles(appTree);
  const first = confirmed[0];
  if (first !== undefined) {
    return passed(
      "dom_use_dom_directive_present",
      "syntax-tree",
      `${first[0]}: has a real 'use dom' directive`,
    );
  }
  if (unavailablePaths.size > 0) {
    return unavailable(
      "dom_use_dom_directive_present",
      "syntax-tree",
      "parser could not confirm any candidate 'use dom' file",
    );
  }
  return failed(
    "dom_use_dom_directive_present",
    "syntax-tree",
    "no file has a confirmed 'use dom' directive",
  );
});

register("dom_layout_excludes_use_dom", "syntax-tree")((appTree) => {
  const { confirmed, unavailablePaths } = domCandidateFiles(appTree);
  const layoutPaths = new Set(
    [...appTree.files.keys()].filter((path) => LAYOUT_FILENAME.test(basename(path))),
  );
  const violatingLayouts = confirmed
    .map(([path]) => path)
    .filter((path) => layoutPaths.has(path))
    .sort();
  if (violatingLayouts[0] !== undefined) {
    return failed(
      "dom_layout_excludes_use_dom",
      "syntax-tree",
      `${violatingLayouts[0]}: a _layout file has a real 'use dom' directive`,
    );
  }
  const unresolvedLayouts = [...layoutPaths]
    .filter((path) => unavailablePaths.has(path))
    .sort();
  if (unresolvedLayouts[0] !== undefined) {
    return unavailable(
      "dom_layout_excludes_use_dom",
      "syntax-tree",
      `parser could not confirm whether ${unresolvedLayouts[0]} has a real 'use dom' directive`,
    );
  }
  if (confirmed.length === 0) {
    return notApplicable(
      "dom_layout_excludes_use_dom",
      "syntax-tree",
      "no file has a confirmed 'use dom' directive -- this rule only applies once a real DOM component exists",
    );
  }
  if (layoutPaths.size === 0) {
    return notApplicable(
      "dom_layout_excludes_use_dom",
      "syntax-tree",
      "no _layout files found",
    );
  }
  return passed(
    "dom_layout_excludes_use_dom",
    "syntax-tree",
    `${confirmed.length} confirmed DOM component(s); none of ${layoutPaths.size} _layout file(s) has a confirmed 'use dom' directive`,
  );
});

register(
  "dom_single_default_export_and_no_native_jsx",
  "syntax-tree",
)((appTree) => {
  const { confirmed, unavailablePaths } = domCandidateFiles(appTree);
  for (const [path, facts] of confirmed) {
    if (facts.defaultExportCount !== 1) {
      return failed(
        "dom_single_default_export_and_no_native_jsx",
        "syntax-tree",
        `${path}: has ${facts.defaultExportCount} default exports, expected exactly 1`,
      );
    }
    if (facts.reactNativeJsxElementsUsed.length > 0) {
      return failed(
        "dom_single_default_export_and_no_native_jsx",
        "syntax-tree",
        `${path}: renders react-native JSX element(s) ${pyList(facts.reactNativeJsxElementsUsed)} inside a DOM component`,
      );
    }
  }
  if (unavailablePaths.size > 0) {
    return unavailable(
      "dom_single_default_export_and_no_native_jsx",
      "syntax-tree",
      `${unavailablePaths.size} candidate 'use dom' file(s) could not be parsed, so full coverage can't be confirmed even though every confirmed file passes`,
    );
  }
  if (confirmed.length === 0) {
    return notApplicable(
      "dom_single_default_export_and_no_native_jsx",
      "syntax-tree",
      "no file has a confirmed 'use dom' directive",
    );
  }
  return passed(
    "dom_single_default_export_and_no_native_jsx",
    "syntax-tree",
    `${confirmed.length} confirmed 'use dom' file(s) each have exactly one default export and no react-native JSX`,
  );
});

register(
  "hosting_no_banned_node_imports_in_api_routes",
  "lexical",
)((appTree) => {
  const apiPaths = [...appTree.files.keys()].filter((path) =>
    API_ROUTE_FILENAME.test(basename(path))
  );
  if (apiPaths.length === 0) {
    return notApplicable(
      "hosting_no_banned_node_imports_in_api_routes",
      "lexical",
      "no +api routes found",
    );
  }
  for (const path of apiPaths) {
    if (BANNED_NODE_IMPORT.test(stripComments(appTree.files.get(path) ?? ""))) {
      return failed(
        "hosting_no_banned_node_imports_in_api_routes",
        "lexical",
        `${path}: imports a banned Node-only builtin in an API route`,
      );
    }
  }
  return passed(
    "hosting_no_banned_node_imports_in_api_routes",
    "lexical",
    `none of ${apiPaths.length} +api route(s) imports a banned Node-only builtin`,
  );
});

register("hosting_api_routes_use_typescript", "structural")((appTree) => {
  const apiPaths = [...appTree.files.keys()].filter((path) =>
    API_ROUTE_FILENAME.test(basename(path))
  );
  if (apiPaths.length === 0) {
    return notApplicable(
      "hosting_api_routes_use_typescript",
      "structural",
      "no +api routes found",
    );
  }
  const nonTypeScript = apiPaths.filter(
    (path) => ![".ts", ".tsx"].includes(extname(path)),
  );
  if (nonTypeScript[0] !== undefined) {
    return failed(
      "hosting_api_routes_use_typescript",
      "structural",
      `${nonTypeScript[0]}: a +api route uses ${extname(nonTypeScript[0])} instead of .ts/.tsx`,
    );
  }
  return passed(
    "hosting_api_routes_use_typescript",
    "structural",
    `all ${apiPaths.length} +api route(s) use TypeScript`,
  );
});

register("data_fetching_expo_public_env_prefix", "lexical")((appTree) => {
  const environmentNames = new Set<string>();
  for (const [path, text] of appTree.files) {
    if (API_ROUTE_FILENAME.test(basename(path))) continue;
    for (const match of stripComments(text).matchAll(PROCESS_ENV_READ)) {
      if (match[1] !== undefined) environmentNames.add(match[1]);
    }
  }
  for (const exempt of ENV_PREFIX_EXEMPT) environmentNames.delete(exempt);
  if (environmentNames.size === 0) {
    return notApplicable(
      "data_fetching_expo_public_env_prefix",
      "lexical",
      "no client-side process.env.* reads found -- no client config needed",
    );
  }
  const nonPublic = [...environmentNames]
    .filter((name) => !name.startsWith("EXPO_PUBLIC_"))
    .sort();
  if (nonPublic.length > 0) {
    return failed(
      "data_fetching_expo_public_env_prefix",
      "lexical",
      `reads client-side env var(s) ${pyList(nonPublic)} without the EXPO_PUBLIC_ prefix`,
    );
  }
  return passed(
    "data_fetching_expo_public_env_prefix",
    "lexical",
    `all client-read env var(s) ${pyList([...environmentNames].sort())} use the EXPO_PUBLIC_ prefix`,
  );
});

register("expo_ui_no_host_from_subpackage", "lexical")((appTree) => {
  for (const [path, text] of appTree.files) {
    if (EXPO_UI_HOST_FROM_SUBPACKAGE.test(stripComments(text))) {
      return failed(
        "expo_ui_no_host_from_subpackage",
        "lexical",
        `${path}: imports Host from a platform-specific @expo/ui subpackage`,
      );
    }
  }
  if (!expoUiImported(appTree)) {
    return notApplicable(
      "expo_ui_no_host_from_subpackage",
      "lexical",
      "no @expo/ui import found -- this rule only applies once the skill is engaged",
    );
  }
  return passed(
    "expo_ui_no_host_from_subpackage",
    "lexical",
    "no file imports Host from a platform-specific @expo/ui subpackage",
  );
});

register(
  "expo_ui_platform_specific_trees_not_in_app_dir",
  "structural",
)((appTree) => {
  const matches = appTree.globAny(EXPO_UI_PLATFORM_TREE_GLOBS);
  if (matches[0] !== undefined) {
    return failed(
      "expo_ui_platform_specific_trees_not_in_app_dir",
      "structural",
      `forbidden path exists: ${relative(appTree.root, matches[0])}`,
    );
  }
  if (!expoUiImported(appTree)) {
    return notApplicable(
      "expo_ui_platform_specific_trees_not_in_app_dir",
      "structural",
      "no @expo/ui import found -- this rule only applies once the skill is engaged",
    );
  }
  return passed(
    "expo_ui_platform_specific_trees_not_in_app_dir",
    "structural",
    `no path matched any of ${pyList(EXPO_UI_PLATFORM_TREE_GLOBS)}`,
  );
});

register("data_fetching_no_axios", "lexical")((appTree) => {
  for (const [path, text] of appTree.files) {
    if (AXIOS_IMPORT.test(stripComments(text))) {
      return failed("data_fetching_no_axios", "lexical", `${path}: imports axios`);
    }
  }
  const engaged = [...appTree.files.values()].some((text) =>
    FETCH_OR_QUERY_LIBS.some((pattern) => pattern.test(stripComments(text)))
  );
  if (!engaged) {
    return notApplicable(
      "data_fetching_no_axios",
      "lexical",
      "no observable data-fetching behavior (no fetch/query-lib usage, no axios import)",
    );
  }
  return passed(
    "data_fetching_no_axios",
    "lexical",
    "data-fetching behavior observed via fetch/query-lib usage, and no axios import found",
  );
});

register("native_ui_no_expo_av", "lexical")((appTree) => {
  for (const [path, text] of appTree.files) {
    if (EXPO_AV_IMPORT.test(stripComments(text))) {
      return failed("native_ui_no_expo_av", "lexical", `${path}: imports expo-av`);
    }
  }
  const engaged = [...appTree.files.values()].some((text) =>
    EXPO_AUDIO_OR_VIDEO_IMPORTS.some((pattern) => pattern.test(stripComments(text)))
  );
  if (!engaged) {
    return notApplicable(
      "native_ui_no_expo_av",
      "lexical",
      "no observable audio/video implementation (no expo-audio/expo-video usage)",
    );
  }
  return passed(
    "native_ui_no_expo_av",
    "lexical",
    "uses expo-audio/expo-video and does not import expo-av",
  );
});

register("native_ui_no_dimensions_get", "lexical")((appTree) => {
  for (const [path, text] of appTree.files) {
    if (DIMENSIONS_GET.test(stripComments(text))) {
      return failed(
        "native_ui_no_dimensions_get",
        "lexical",
        `${path}: calls Dimensions.get()`,
      );
    }
  }
  const engaged = [...appTree.files.values()].some((text) =>
    USE_WINDOW_DIMENSIONS.test(stripComments(text))
  );
  if (!engaged) {
    return notApplicable(
      "native_ui_no_dimensions_get",
      "lexical",
      "no observable window measurement (no useWindowDimensions() usage)",
    );
  }
  return passed(
    "native_ui_no_dimensions_get",
    "lexical",
    "uses useWindowDimensions() and does not call Dimensions.get()",
  );
});

register(
  "native_ui_no_safe_area_view_from_react_native",
  "lexical",
)((appTree) => {
  for (const [path, text] of appTree.files) {
    if (SAFE_AREA_VIEW_FROM_REACT_NATIVE.test(stripComments(text))) {
      return failed(
        "native_ui_no_safe_area_view_from_react_native",
        "lexical",
        `${path}: imports SafeAreaView from react-native`,
      );
    }
  }
  const engaged = [...appTree.files.values()].some((text) =>
    SAFE_AREA_CONTEXT_IMPORT.test(stripComments(text))
  );
  if (!engaged) {
    return notApplicable(
      "native_ui_no_safe_area_view_from_react_native",
      "lexical",
      "no observable safe-area handling (no react-native-safe-area-context usage)",
    );
  }
  return passed(
    "native_ui_no_safe_area_view_from_react_native",
    "lexical",
    "uses react-native-safe-area-context and does not import SafeAreaView from react-native",
  );
});

register("router_no_direct_react_navigation_import", "lexical")((appTree) => {
  for (const [path, text] of appTree.files) {
    if (REACT_NAVIGATION_IMPORT.test(stripComments(text))) {
      return failed(
        "router_no_direct_react_navigation_import",
        "lexical",
        `${path}: imports @react-navigation/* directly`,
      );
    }
  }
  const engaged = [...appTree.files.values()].some((text) =>
    EXPO_ROUTER_IMPORT.test(stripComments(text))
  );
  if (!engaged) {
    return notApplicable(
      "router_no_direct_react_navigation_import",
      "lexical",
      "no expo-router import found -- this rule only applies once the app engages with routing",
    );
  }
  return passed(
    "router_no_direct_react_navigation_import",
    "lexical",
    "no file imports @react-navigation/* directly",
  );
});

function pyList(values: string[]): string {
  return `[${values.map((value) => `'${value.replaceAll("'", "\\'")}'`).join(", ")}]`;
}

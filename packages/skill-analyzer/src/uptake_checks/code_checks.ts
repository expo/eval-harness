import { basename, extname, relative } from 'node:path';

import { extractAstFactsFromSource, type AstFacts } from '../build_health/node_parser.ts';
import { compareUnicodeCodePoints } from '../utils.ts';
import type { AppTree, CheckResult, CheckRunner, CheckStatus } from './registry.ts';

type ResultFields = {
  id: string;
  category: string;
  kind: string;
  target: unknown;
  passed: boolean | null;
  evidence: string;
  status: CheckStatus;
};

type CodeCheckBindings = {
  register: (
    checkId: string,
    category: string,
    description?: string
  ) => (runner: CheckRunner) => CheckRunner;
  createResult: (fields: ResultFields) => CheckResult;
  stripComments: (text: string) => string;
};

let createResult: CodeCheckBindings['createResult'];
let stripComments: CodeCheckBindings['stripComments'];

const USE_DOM_CANDIDATE = /['"]use dom['"]/u;
const LAYOUT_FILENAME = /^_layout\.(t|j)sx?$/u;
const API_ROUTE_FILENAME = /\+api\.(t|j)sx?$/u;
const BANNED_NODE_IMPORT =
  /from\s+['"](fs|node:fs|node:crypto|node-fetch)['"]|require\(['"](fs|node:fs|node:crypto|node-fetch)['"]\)/u;
const PROCESS_ENV_READ = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu;
const ENV_PREFIX_EXEMPT = new Set(['NODE_ENV', 'EXPO_OS']);

const EXPO_UI_IMPORTS = [
  /from\s*['"]@expo\/ui['"]/u,
  /from\s*['"]@expo\/ui\/swift-ui['"]/u,
  /from\s*['"]@expo\/ui\/jetpack-compose['"]/u,
  /from\s*['"]@expo\/ui\/community\//u,
];
const EXPO_UI_HOST_FROM_SUBPACKAGE =
  /\bHost\b[^\n]*from\s*['"]@expo\/ui\/(swift-ui|jetpack-compose)['"]/u;
const EXPO_UI_PLATFORM_TREE_GLOBS = [
  'app/**/*.ios.tsx',
  'app/**/*.android.tsx',
  'src/app/**/*.ios.tsx',
  'src/app/**/*.android.tsx',
];
const FETCH_OR_QUERY_LIBS = [
  /fetch\(/u,
  /from\s*['"]@tanstack\/react-query['"]/u,
  /from\s*['"]swr['"]/u,
];
const AXIOS_IMPORT = /from\s*['"]axios['"]/u;
const EXPO_AV_IMPORT = /from\s*['"]expo-av['"]/u;
const EXPO_AUDIO_OR_VIDEO_IMPORTS = [/from\s*['"]expo-audio['"]/u, /from\s*['"]expo-video['"]/u];
const DIMENSIONS_GET = /Dimensions\.get\(/u;
const USE_WINDOW_DIMENSIONS = /useWindowDimensions\(/u;
const SAFE_AREA_VIEW_FROM_REACT_NATIVE =
  /import\s*\{[^}]*\bSafeAreaView\b[^}]*\}\s*from\s*['"]react-native['"]/u;
const SAFE_AREA_CONTEXT_IMPORT = /from\s*['"]react-native-safe-area-context['"]/u;
const EXPO_ROUTER_IMPORT = /from\s*['"]expo-router['"]|require\(['"]expo-router['"]\)/u;
const REACT_NAVIGATION_IMPORT = /from\s*['"]@react-navigation\//u;

const CODE_CHECK_DESCRIPTIONS = {
  dom_use_dom_directive_present:
    "expo-dom rule: a DOM component file must start with the 'use dom' directive. AST-backed (not a declarative regex check) because a directive is a specific JS-grammar position (a leading string-literal-expression-statement) -- a regex anchored to 'appears alone on its own line' still matches a `\"use dom\";` statement placed after other code, which is not a real directive and has no DOM-component effect. If the app has zero real 'use dom' files, this is the check that should read failed (this skill was expected but never engaged with at all) -- its sibling checks (dom_layout_excludes_use_dom, dom_single_default_export_and_no_native_jsx) read not_applicable in that case instead, since their own rules only make sense once at least one real DOM component exists.",
  dom_layout_excludes_use_dom:
    "expo-dom rule: a _layout file must never itself be a DOM component. AST-backed (uses the same confirmed-directive facts as dom_use_dom_directive_present) so an unrelated 'use dom'-shaped string inside a _layout file (a comment, an unrelated string constant) doesn't false-fail this check -- only a real, AST-confirmed directive counts as the violation. not_applicable if the app has no real confirmed DOM component at all (third review round: gating this only on 'no _layout files' let an ordinary app with zero DOM usage vacuously pass, since almost every expo-router app has _layout files -- this now matches dom_single_default_export_and_no_native_jsx's own not_applicable precondition), or if the app has a confirmed DOM component but no _layout files at all.",
  dom_single_default_export_and_no_native_jsx:
    "expo-dom rule: a 'use dom' file must have exactly one default export and must not render a react-native primitive as JSX (including namespace imports like `import * as RN` and JSXMemberExpression usages like <RN.Text>) -- both need real AST facts that regex can't verify without false positives/negatives. Aggregation across every confirmed 'use dom' file, in order: (1) any confirmed file with a real violation -> failed; (2) else, any candidate the parser couldn't resolve -> unavailable (a second file parsing cleanly must not hide a different file's parser failure); (3) else, if no file was ever confirmed as a real DOM component -> not_applicable; (4) else -> passed.",
  hosting_no_banned_node_imports_in_api_routes:
    'eas-hosting rule: +api.ts route files run on an edge runtime and must not import Node-only builtins (fs, node:crypto) or node-fetch. Code-driven because it must filter to just +api.* files, not the whole app. not_applicable if the app has no API routes at all (EAS Hosting also serves static sites with no API routes).',
  hosting_api_routes_use_typescript:
    'eas-hosting rule: use TypeScript for API routes -- a plain-JS +api.js/+api.jsx file is the anti-pattern. not_applicable if the app has no API routes at all.',
  data_fetching_expo_public_env_prefix:
    "expo-data-fetching rule: only EXPO_PUBLIC_-prefixed env vars are exposed client-side. Code-driven (not a bare presence-of-EXPO_PUBLIC_ regex) so it can verify the naming convention against whichever env vars the app actually reads, and return not_applicable rather than a scored fail when the app reads no client env var at all -- confirmed live: both real hot_chocolate and wiki_reader apps read zero client env vars (a self-contained app and a WebView wrapper respectively), so a presence-only check would always fail them regardless of true skill uptake. Excludes +api.* route files entirely: the skill explicitly endorses unprefixed server-only secrets there (e.g. an OpenAI API key read inside a +api.ts handler), which is the opposite of a violation. Strips comments before scanning, same as every declarative check, so a commented-out example doesn't count.",
  expo_ui_no_host_from_subpackage:
    "expo-ui rule: Host must always be imported from the '@expo/ui' root, never from a platform-specific subpackage. Converted from a declarative text_absent check (third review round): a bare absence check vacuously passed for apps that never imported @expo/ui at all, so this is now not_applicable unless the app actually imports @expo/ui somewhere.",
  expo_ui_platform_specific_trees_not_in_app_dir:
    "expo-ui rule: platform-specific @expo/ui trees must live in components/, never under app/ -- Expo Router doesn't support platform extensions for route files. Converted from a declarative path_absent check (third review round): same vacuous-pass problem as expo_ui_no_host_from_subpackage above.",
  data_fetching_no_axios:
    'expo-data-fetching rule: avoid axios, prefer the built-in fetch (or expo/fetch). Converted from a declarative text_absent check (third review round): a bare absence check vacuously passed for apps with no observable data-fetching behavior at all. Finding axios itself is always scored (importing it is proof the app engaged with data fetching, even if the wrong way); a clean pass additionally requires observable fetch/query-lib usage as independent proof of engagement -- otherwise not_applicable.',
  native_ui_no_expo_av:
    "expo-native-ui rule: expo-av is removed -- use expo-audio/expo-video instead. Fourth review round: gated on this feature's OWN positive replacement (expo-audio/expo-video usage), not a shared skill-wide signal -- using react-native-safe-area-context or useWindowDimensions says nothing about whether the app made a correct media choice. Finding expo-av itself is always scored regardless of gating, since importing it is proof this feature area was engaged.",
  native_ui_no_dimensions_get:
    "expo-native-ui rule: use useWindowDimensions, not Dimensions.get(). Fourth review round: gated on this feature's OWN positive replacement (useWindowDimensions usage), not a shared skill-wide signal -- see native_ui_no_expo_av above for why. Finding Dimensions.get() itself is always scored regardless of gating.",
  native_ui_no_safe_area_view_from_react_native:
    "expo-native-ui rule: use react-native-safe-area-context, not react-native's own SafeAreaView. Fourth review round: gated on this feature's OWN positive replacement (react-native-safe-area-context usage), not a shared skill-wide signal -- see native_ui_no_expo_av above for why. Anchored to the import statement (not a bare word match) to avoid flagging the correct import from react-native-safe-area-context. Finding SafeAreaView imported from react-native itself is always scored regardless of gating.",
  router_no_direct_react_navigation_import:
    "SDK 56+ rule: never import @react-navigation/* directly -- use expo-router/react-navigation instead. Converted from a declarative text_absent check (third review round): shared by expo-router and expo-native-ui, and a bare absence check vacuously passed for an app with zero navigation engagement of any kind. Gated on an expo-router import (virtually always present in a real expo-router app, so this rarely changes expo-router's own scoring) -- finding a direct @react-navigation import is itself scored regardless of gating, since importing it is proof of navigation engagement.",
} as const;

function passed(checkId: string, category: string, evidence: string): CheckResult {
  return createResult({
    id: checkId,
    category,
    kind: 'code',
    target: null,
    passed: true,
    evidence,
    status: 'passed',
  });
}

function failed(checkId: string, category: string, evidence: string): CheckResult {
  return createResult({
    id: checkId,
    category,
    kind: 'code',
    target: null,
    passed: false,
    evidence,
    status: 'failed',
  });
}

function notApplicable(checkId: string, category: string, evidence: string): CheckResult {
  return createResult({
    id: checkId,
    category,
    kind: 'code',
    target: null,
    passed: null,
    evidence,
    status: 'not_applicable',
  });
}

function unavailable(checkId: string, category: string, evidence: string): CheckResult {
  return createResult({
    id: checkId,
    category,
    kind: 'code',
    target: null,
    passed: null,
    evidence,
    status: 'unavailable',
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
    const facts = extractAstFactsFromSource(appTree.files.get(path) ?? '');
    if ('error' in facts) {
      unavailablePaths.add(path);
      continue;
    }
    if (facts.hasUseDomDirective) confirmed.push([path, facts]);
  }
  return { confirmed, unavailablePaths };
}

export function registerCodeChecks(bindings: CodeCheckBindings): void {
  createResult = bindings.createResult;
  stripComments = bindings.stripComments;
  const { register } = bindings;

  register(
    'dom_use_dom_directive_present',
    'syntax-tree',
    CODE_CHECK_DESCRIPTIONS.dom_use_dom_directive_present
  )((appTree) => {
    const { confirmed, unavailablePaths } = domCandidateFiles(appTree);
    const first = confirmed[0];
    if (first !== undefined) {
      return passed(
        'dom_use_dom_directive_present',
        'syntax-tree',
        `${first[0]}: has a real 'use dom' directive`
      );
    }
    if (unavailablePaths.size > 0) {
      return unavailable(
        'dom_use_dom_directive_present',
        'syntax-tree',
        "parser could not confirm any candidate 'use dom' file"
      );
    }
    return failed(
      'dom_use_dom_directive_present',
      'syntax-tree',
      "no file has a confirmed 'use dom' directive"
    );
  });

  register(
    'dom_layout_excludes_use_dom',
    'syntax-tree',
    CODE_CHECK_DESCRIPTIONS.dom_layout_excludes_use_dom
  )((appTree) => {
    const { confirmed, unavailablePaths } = domCandidateFiles(appTree);
    const layoutPaths = new Set(
      [...appTree.files.keys()].filter((path) => LAYOUT_FILENAME.test(basename(path)))
    );
    const violatingLayouts = confirmed
      .map(([path]) => path)
      .filter((path) => layoutPaths.has(path))
      .sort(compareUnicodeCodePoints);
    if (violatingLayouts[0] !== undefined) {
      return failed(
        'dom_layout_excludes_use_dom',
        'syntax-tree',
        `${violatingLayouts[0]}: a _layout file has a real 'use dom' directive`
      );
    }
    const unresolvedLayouts = [...layoutPaths]
      .filter((path) => unavailablePaths.has(path))
      .sort(compareUnicodeCodePoints);
    if (unresolvedLayouts[0] !== undefined) {
      return unavailable(
        'dom_layout_excludes_use_dom',
        'syntax-tree',
        `parser could not confirm whether ${unresolvedLayouts[0]} has a real 'use dom' directive`
      );
    }
    if (confirmed.length === 0) {
      return notApplicable(
        'dom_layout_excludes_use_dom',
        'syntax-tree',
        "no file has a confirmed 'use dom' directive -- this rule only applies once a real DOM component exists"
      );
    }
    if (layoutPaths.size === 0) {
      return notApplicable('dom_layout_excludes_use_dom', 'syntax-tree', 'no _layout files found');
    }
    return passed(
      'dom_layout_excludes_use_dom',
      'syntax-tree',
      `${confirmed.length} confirmed DOM component(s); none of ${layoutPaths.size} _layout file(s) has a confirmed 'use dom' directive`
    );
  });

  register(
    'dom_single_default_export_and_no_native_jsx',
    'syntax-tree',
    CODE_CHECK_DESCRIPTIONS.dom_single_default_export_and_no_native_jsx
  )((appTree) => {
    const { confirmed, unavailablePaths } = domCandidateFiles(appTree);
    for (const [path, facts] of confirmed) {
      if (facts.defaultExportCount !== 1) {
        return failed(
          'dom_single_default_export_and_no_native_jsx',
          'syntax-tree',
          `${path}: has ${facts.defaultExportCount} default exports, expected exactly 1`
        );
      }
      if (facts.reactNativeJsxElementsUsed.length > 0) {
        return failed(
          'dom_single_default_export_and_no_native_jsx',
          'syntax-tree',
          `${path}: renders react-native JSX element(s) ${pyList(facts.reactNativeJsxElementsUsed)} inside a DOM component`
        );
      }
    }
    if (unavailablePaths.size > 0) {
      return unavailable(
        'dom_single_default_export_and_no_native_jsx',
        'syntax-tree',
        `${unavailablePaths.size} candidate 'use dom' file(s) could not be parsed, so full coverage can't be confirmed even though every confirmed file passes`
      );
    }
    if (confirmed.length === 0) {
      return notApplicable(
        'dom_single_default_export_and_no_native_jsx',
        'syntax-tree',
        "no file has a confirmed 'use dom' directive"
      );
    }
    return passed(
      'dom_single_default_export_and_no_native_jsx',
      'syntax-tree',
      `${confirmed.length} confirmed 'use dom' file(s) each have exactly one default export and no react-native JSX`
    );
  });

  register(
    'hosting_no_banned_node_imports_in_api_routes',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.hosting_no_banned_node_imports_in_api_routes
  )((appTree) => {
    const apiPaths = [...appTree.files.keys()].filter((path) =>
      API_ROUTE_FILENAME.test(basename(path))
    );
    if (apiPaths.length === 0) {
      return notApplicable(
        'hosting_no_banned_node_imports_in_api_routes',
        'lexical',
        'no +api routes found'
      );
    }
    for (const path of apiPaths) {
      if (BANNED_NODE_IMPORT.test(stripComments(appTree.files.get(path) ?? ''))) {
        return failed(
          'hosting_no_banned_node_imports_in_api_routes',
          'lexical',
          `${path}: imports a banned Node-only builtin in an API route`
        );
      }
    }
    return passed(
      'hosting_no_banned_node_imports_in_api_routes',
      'lexical',
      `none of ${apiPaths.length} +api route(s) imports a banned Node-only builtin`
    );
  });

  register(
    'hosting_api_routes_use_typescript',
    'structural',
    CODE_CHECK_DESCRIPTIONS.hosting_api_routes_use_typescript
  )((appTree) => {
    const apiPaths = [...appTree.files.keys()].filter((path) =>
      API_ROUTE_FILENAME.test(basename(path))
    );
    if (apiPaths.length === 0) {
      return notApplicable(
        'hosting_api_routes_use_typescript',
        'structural',
        'no +api routes found'
      );
    }
    const nonTypeScript = apiPaths.filter((path) => !['.ts', '.tsx'].includes(extname(path)));
    if (nonTypeScript[0] !== undefined) {
      return failed(
        'hosting_api_routes_use_typescript',
        'structural',
        `${nonTypeScript[0]}: a +api route uses ${extname(nonTypeScript[0])} instead of .ts/.tsx`
      );
    }
    return passed(
      'hosting_api_routes_use_typescript',
      'structural',
      `all ${apiPaths.length} +api route(s) use TypeScript`
    );
  });

  register(
    'data_fetching_expo_public_env_prefix',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.data_fetching_expo_public_env_prefix
  )((appTree) => {
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
        'data_fetching_expo_public_env_prefix',
        'lexical',
        'no client-side process.env.* reads found -- no client config needed'
      );
    }
    const nonPublic = [...environmentNames]
      .filter((name) => !name.startsWith('EXPO_PUBLIC_'))
      .sort(compareUnicodeCodePoints);
    if (nonPublic.length > 0) {
      return failed(
        'data_fetching_expo_public_env_prefix',
        'lexical',
        `reads client-side env var(s) ${pyList(nonPublic)} without the EXPO_PUBLIC_ prefix`
      );
    }
    return passed(
      'data_fetching_expo_public_env_prefix',
      'lexical',
      `all client-read env var(s) ${pyList([...environmentNames].sort(compareUnicodeCodePoints))} use the EXPO_PUBLIC_ prefix`
    );
  });

  register(
    'expo_ui_no_host_from_subpackage',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.expo_ui_no_host_from_subpackage
  )((appTree) => {
    for (const [path, text] of appTree.files) {
      if (EXPO_UI_HOST_FROM_SUBPACKAGE.test(stripComments(text))) {
        return failed(
          'expo_ui_no_host_from_subpackage',
          'lexical',
          `${path}: imports Host from a platform-specific @expo/ui subpackage`
        );
      }
    }
    if (!expoUiImported(appTree)) {
      return notApplicable(
        'expo_ui_no_host_from_subpackage',
        'lexical',
        'no @expo/ui import found -- this rule only applies once the skill is engaged'
      );
    }
    return passed(
      'expo_ui_no_host_from_subpackage',
      'lexical',
      'no file imports Host from a platform-specific @expo/ui subpackage'
    );
  });

  register(
    'expo_ui_platform_specific_trees_not_in_app_dir',
    'structural',
    CODE_CHECK_DESCRIPTIONS.expo_ui_platform_specific_trees_not_in_app_dir
  )(async (appTree) => {
    const matches = await appTree.globAny(EXPO_UI_PLATFORM_TREE_GLOBS);
    if (matches[0] !== undefined) {
      return failed(
        'expo_ui_platform_specific_trees_not_in_app_dir',
        'structural',
        `forbidden path exists: ${relative(appTree.root, matches[0])}`
      );
    }
    if (!expoUiImported(appTree)) {
      return notApplicable(
        'expo_ui_platform_specific_trees_not_in_app_dir',
        'structural',
        'no @expo/ui import found -- this rule only applies once the skill is engaged'
      );
    }
    return passed(
      'expo_ui_platform_specific_trees_not_in_app_dir',
      'structural',
      `no path matched any of ${pyList(EXPO_UI_PLATFORM_TREE_GLOBS)}`
    );
  });

  register(
    'data_fetching_no_axios',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.data_fetching_no_axios
  )((appTree) => {
    for (const [path, text] of appTree.files) {
      if (AXIOS_IMPORT.test(stripComments(text))) {
        return failed('data_fetching_no_axios', 'lexical', `${path}: imports axios`);
      }
    }
    const engaged = [...appTree.files.values()].some((text) =>
      FETCH_OR_QUERY_LIBS.some((pattern) => pattern.test(stripComments(text)))
    );
    if (!engaged) {
      return notApplicable(
        'data_fetching_no_axios',
        'lexical',
        'no observable data-fetching behavior (no fetch/query-lib usage, no axios import)'
      );
    }
    return passed(
      'data_fetching_no_axios',
      'lexical',
      'data-fetching behavior observed via fetch/query-lib usage, and no axios import found'
    );
  });

  register(
    'native_ui_no_expo_av',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.native_ui_no_expo_av
  )((appTree) => {
    for (const [path, text] of appTree.files) {
      if (EXPO_AV_IMPORT.test(stripComments(text))) {
        return failed('native_ui_no_expo_av', 'lexical', `${path}: imports expo-av`);
      }
    }
    const engaged = [...appTree.files.values()].some((text) =>
      EXPO_AUDIO_OR_VIDEO_IMPORTS.some((pattern) => pattern.test(stripComments(text)))
    );
    if (!engaged) {
      return notApplicable(
        'native_ui_no_expo_av',
        'lexical',
        'no observable audio/video implementation (no expo-audio/expo-video usage)'
      );
    }
    return passed(
      'native_ui_no_expo_av',
      'lexical',
      'uses expo-audio/expo-video and does not import expo-av'
    );
  });

  register(
    'native_ui_no_dimensions_get',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.native_ui_no_dimensions_get
  )((appTree) => {
    for (const [path, text] of appTree.files) {
      if (DIMENSIONS_GET.test(stripComments(text))) {
        return failed('native_ui_no_dimensions_get', 'lexical', `${path}: calls Dimensions.get()`);
      }
    }
    const engaged = [...appTree.files.values()].some((text) =>
      USE_WINDOW_DIMENSIONS.test(stripComments(text))
    );
    if (!engaged) {
      return notApplicable(
        'native_ui_no_dimensions_get',
        'lexical',
        'no observable window measurement (no useWindowDimensions() usage)'
      );
    }
    return passed(
      'native_ui_no_dimensions_get',
      'lexical',
      'uses useWindowDimensions() and does not call Dimensions.get()'
    );
  });

  register(
    'native_ui_no_safe_area_view_from_react_native',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.native_ui_no_safe_area_view_from_react_native
  )((appTree) => {
    for (const [path, text] of appTree.files) {
      if (SAFE_AREA_VIEW_FROM_REACT_NATIVE.test(stripComments(text))) {
        return failed(
          'native_ui_no_safe_area_view_from_react_native',
          'lexical',
          `${path}: imports SafeAreaView from react-native`
        );
      }
    }
    const engaged = [...appTree.files.values()].some((text) =>
      SAFE_AREA_CONTEXT_IMPORT.test(stripComments(text))
    );
    if (!engaged) {
      return notApplicable(
        'native_ui_no_safe_area_view_from_react_native',
        'lexical',
        'no observable safe-area handling (no react-native-safe-area-context usage)'
      );
    }
    return passed(
      'native_ui_no_safe_area_view_from_react_native',
      'lexical',
      'uses react-native-safe-area-context and does not import SafeAreaView from react-native'
    );
  });

  register(
    'router_no_direct_react_navigation_import',
    'lexical',
    CODE_CHECK_DESCRIPTIONS.router_no_direct_react_navigation_import
  )((appTree) => {
    for (const [path, text] of appTree.files) {
      if (REACT_NAVIGATION_IMPORT.test(stripComments(text))) {
        return failed(
          'router_no_direct_react_navigation_import',
          'lexical',
          `${path}: imports @react-navigation/* directly`
        );
      }
    }
    const engaged = [...appTree.files.values()].some((text) =>
      EXPO_ROUTER_IMPORT.test(stripComments(text))
    );
    if (!engaged) {
      return notApplicable(
        'router_no_direct_react_navigation_import',
        'lexical',
        'no expo-router import found -- this rule only applies once the app engages with routing'
      );
    }
    return passed(
      'router_no_direct_react_navigation_import',
      'lexical',
      'no file imports @react-navigation/* directly'
    );
  });
}

function pyList(values: string[]): string {
  return `[${values.map((value) => `'${value.replaceAll("'", "\\'")}'`).join(', ')}]`;
}

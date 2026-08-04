import { join } from "node:path";

import { AppTree } from "../uptake_checks/registry.ts";
import { checkFileSyntax } from "./node_parser.ts";

export type SyntaxCheckResult = {
  total_files: number;
  checked_files: number;
  skipped_unavailable: number;
  failed_files: Array<{ file: string; message: string }>;
  ok: boolean | null;
};

export function checkSyntax(appDir: string): SyntaxCheckResult {
  const appTree = new AppTree(appDir);
  const failedFiles: Array<{ file: string; message: string }> = [];
  for (const relativePath of appTree.files.keys()) {
    const facts = checkFileSyntax(join(appDir, relativePath));
    if ("error" in facts) {
      failedFiles.push({ file: relativePath, message: facts.message });
    }
  }
  const total = appTree.files.size;
  return {
    total_files: total,
    checked_files: total,
    skipped_unavailable: 0,
    failed_files: failedFiles,
    ok: total > 0 ? failedFiles.length === 0 : null,
  };
}

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as createArchive, Header } from "tar";

import { materializeArtifact } from "../artifacts/materialize.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "materialize-artifact-"));
  roots.push(value);
  return value;
}

function fixture(base: string, nested = false): string {
  const artifact = nested ? join(base, "authored-app") : base;
  mkdirSync(join(artifact, "author-agent-workspace/run-1"), { recursive: true });
  writeFileSync(join(artifact, "manifest.json"), '{"schema_version":2,"artifact_type":"authored-app"}');
  writeFileSync(join(artifact, "author-agent-workspace/run-1/package.json"), '{"name":"fixture"}');
  return artifact;
}

function rawTar(
  path: string,
  entries: Array<{ path: string; type: "File" | "Link" | "SymbolicLink" | "FIFO"; linkpath?: string; contents?: string }>,
): void {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "");
    const header = new Header({
      path: entry.path,
      type: entry.type,
      ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
      size: entry.type === "File" ? contents.length : 0,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
    });
    const headerBlock = Buffer.alloc(512);
    header.encode(headerBlock);
    blocks.push(headerBlock, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(path, Buffer.concat(blocks));
}

test("materializes canonical direct tar and EAS archive directory", () => {
  const base = root();
  const source = fixture(join(base, "source"));
  const direct = join(base, "authored-app.tar.gz");
  createArchive({ file: direct, cwd: source, gzip: true, sync: true }, ["."]);

  const directOut = join(base, "direct-out");
  expect(materializeArtifact(direct, directOut, "authored-app")).toBe(directOut);
  expect(existsSync(join(directOut, "manifest.json"))).toBe(true);

  const easDirectory = join(base, "eas-download");
  mkdirSync(easDirectory);
  const easArchive = join(easDirectory, "authored-app.tar.gz");
  createArchive({ file: easArchive, cwd: source, gzip: true, sync: true }, ["."]);
  const easOut = join(base, "eas-out");
  const cli = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "../artifacts/materialize.ts"),
    "--artifact", easDirectory,
    "--dest", easOut,
    "--root-name", "authored-app",
  ]);
  expect(cli.exitCode).toBe(0);
  expect(existsSync(join(easOut, "author-agent-workspace/run-1/package.json"))).toBe(true);
});

test("normalizes a nested canonical root and preserves an intended legacy archive", () => {
  const base = root();
  const nestedDownload = join(base, "nested-download");
  fixture(nestedDownload, true);
  const nestedOut = join(base, "nested-out");
  materializeArtifact(nestedDownload, nestedOut, "authored-app");
  expect(existsSync(join(nestedOut, "manifest.json"))).toBe(true);
  expect(existsSync(join(nestedOut, "authored-app"))).toBe(false);

  const legacySource = join(base, "legacy-source");
  mkdirSync(join(legacySource, "legacy-workspace/run-1"), { recursive: true });
  writeFileSync(join(legacySource, "legacy-workspace/run-1/package.json"), "{}");
  const legacyArchive = join(base, "legacy.tar.gz");
  createArchive({ file: legacyArchive, cwd: legacySource, gzip: true, sync: true }, ["."]);
  const legacyOut = join(base, "legacy-out");
  materializeArtifact(legacyArchive, legacyOut, "authored-app");
  expect(existsSync(join(legacyOut, "legacy-workspace/run-1/package.json"))).toBe(true);
});

test("rejects traversal, links, and special entries without mutating the prior destination", () => {
  for (const [name, entries] of [
    ["traversal", [{ path: "../escape", type: "File", contents: "bad" }]],
    ["symlink", [{ path: "target", type: "File", contents: "ok" }, { path: "link", type: "SymbolicLink", linkpath: "target" }]],
    ["hardlink", [{ path: "target", type: "File", contents: "ok" }, { path: "link", type: "Link", linkpath: "target" }]],
    ["special", [{ path: "pipe", type: "FIFO" }]],
  ] as const) {
    const base = root();
    const archive = join(base, `${name}.tar`);
    const destination = join(base, "destination");
    mkdirSync(destination);
    writeFileSync(join(destination, "sentinel"), "prior");
    rawTar(archive, [...entries]);
    expect(() => materializeArtifact(archive, destination, "authored-app")).toThrow();
    expect(readFileSync(join(destination, "sentinel"), "utf8")).toBe("prior");
    expect(existsSync(join(base, "escape"))).toBe(false);
  }
});

test("clean replacement removes stale files only after validation succeeds", () => {
  const base = root();
  const source = fixture(join(base, "source"));
  const archive = join(base, "artifact.tar.gz");
  const destination = join(base, "destination");
  createArchive({ file: archive, cwd: source, gzip: true, sync: true }, ["."]);
  materializeArtifact(archive, destination, "authored-app");
  writeFileSync(join(destination, "stale"), "old");
  writeFileSync(join(source, "current"), "new");
  createArchive({ file: archive, cwd: source, gzip: true, sync: true }, ["."]);

  materializeArtifact(archive, destination, "authored-app");
  expect(existsSync(join(destination, "stale"))).toBe(false);
  expect(readFileSync(join(destination, "current"), "utf8")).toBe("new");
});

test("rejects a destination that overlaps the artifact source before mutating it", () => {
  const base = root();
  const source = fixture(join(base, "source"));
  const sentinel = join(source, "sentinel");
  writeFileSync(sentinel, "source-remains");

  expect(() => materializeArtifact(source, source, "authored-app")).toThrow(/overlap/u);
  expect(readFileSync(sentinel, "utf8")).toBe("source-remains");

  const nestedDestination = join(source, "materialized");
  expect(() => materializeArtifact(source, nestedDestination, "authored-app")).toThrow(/overlap/u);
  expect(existsSync(nestedDestination)).toBe(false);
  expect(readFileSync(sentinel, "utf8")).toBe("source-remains");
});

test("rejects an archive symlink selected from an EAS download directory", () => {
  const base = root();
  const source = fixture(join(base, "source"));
  const realArchive = join(base, "real.tar.gz");
  createArchive({ file: realArchive, cwd: source, gzip: true, sync: true }, ["."]);
  const download = join(base, "download");
  mkdirSync(download);
  symlinkSync(realArchive, join(download, "authored-app.tar.gz"));
  const destination = join(base, "destination");

  expect(() => materializeArtifact(download, destination, "authored-app")).toThrow(/physical single-link/u);
  expect(existsSync(destination)).toBe(false);
});

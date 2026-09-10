// Trusted verifier entrypoint; authored code is imported in this child only.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert";
import type { Check } from "./outcomes.ts";

const checks: Check[] = [];
let loadItems: (url: string) => Promise<unknown>;
try {
  const module = await import(
    pathToFileURL(join(process.argv[2]!, "src/load-items.ts")).href
  );
  if (typeof module.loadItems !== "function")
    throw new Error("Missing loadItems export");
  loadItems = module.loadItems;
} catch (error) {
  for (const id of [
    "http-error-no-parse",
    "http-success-data",
    "network-error",
  ])
    checks.push({
      id,
      status: "failed",
      evidence: `Cannot load helper: ${String(error)}`,
    });
  console.log(JSON.stringify(checks));
  process.exit(0);
}

async function check(id: string, test: () => Promise<void>, evidence: string) {
  try {
    await test();
    checks.push({ id, status: "passed", evidence });
  } catch (error) {
    checks.push({ id, status: "failed", evidence: String(error) });
  }
}
const url = "https://fixture.invalid/items";
await check(
  "http-error-no-parse",
  async () => {
    for (const status of [404, 500]) {
      let parsed = false,
        fetched = false,
        rejected = false;
      globalThis.fetch = (async (input: unknown) => {
        deepStrictEqual(input, url);
        fetched = true;
        return {
          ok: false,
          status,
          statusText: "Failure",
          json: async () => {
            parsed = true;
            return { error: true };
          },
        };
      }) as unknown as typeof fetch;
      try {
        await loadItems(url);
      } catch {
        rejected = true;
      }
      if (!fetched || !rejected || parsed)
        throw new Error(
          `HTTP ${status}: fetched=${fetched}, rejected=${rejected}, parsed=${parsed}`,
        );
    }
  },
  "404 and 500 reject before JSON parsing",
);
await check(
  "http-success-data",
  async () => {
    let fetched = false,
      parses = 0;
    const data = [{ id: "a", title: "First" }];
    globalThis.fetch = (async (input: unknown) => {
      deepStrictEqual(input, url);
      fetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => {
          parses++;
          return data;
        },
      };
    }) as unknown as typeof fetch;
    deepStrictEqual(await loadItems(url), data);
    if (!fetched || parses !== 1)
      throw new Error("Success must fetch and parse once");
  },
  "200 returns the parsed response data",
);
await check(
  "network-error",
  async () => {
    let fetched = false,
      rejected = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("Network unavailable");
    }) as unknown as typeof fetch;
    try {
      await loadItems(url);
    } catch {
      rejected = true;
    }
    if (!fetched || !rejected) throw new Error("Network failure must reject");
  },
  "Network rejection is not converted to successful data",
);
console.log(JSON.stringify(checks));

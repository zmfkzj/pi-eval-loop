#!/usr/bin/env node
// Reproducible checkJs comparison of pi-eval-loop between a base umbrella commit and the working tree.
// The package has no typecheck script; this runs the umbrella's TypeScript (orche/node_modules/typescript) with --allowJs
// --checkJs --noEmit over pi-eval-loop/{src,bin,test,extension,scripts} under two option sets:
//   - "plain": types [] (the configuration of the protocol-2 report: node builtins unresolved),
//   - "node":  @types/node from orche/node_modules/@types (node builtins resolved).
// Diagnostics are compared as a multiset of (file, code, message) without positions, so moved lines do not count as changes.
// Usage: node pi-eval-loop/scripts/checkjs-compare.mjs <base-commit> <out-dir>
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [base, outArg] = process.argv.slice(2);
if (!base || !outArg) { console.error("usage: checkjs-compare.mjs <base-commit> <out-dir>"); process.exit(2); }
const umbrella = resolve(new URL("../..", import.meta.url).pathname);
const out = resolve(outArg);
const tsc = join(umbrella, "orche/node_modules/typescript/bin/tsc");
const typeRoot = join(umbrella, "orche/node_modules/@types");
const dirs = ["src", "bin", "test", "extension", "scripts"];
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "checkjs-"));
try {
  const sides = { base: join(work, "base"), final: join(work, "final") };
  mkdirSync(sides.base, { recursive: true });
  const archive = execFileSync("git", ["-C", umbrella, "archive", base, "pi-eval-loop"], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", sides.base], { input: archive });
  for (const d of dirs) if (existsSync(join(umbrella, "pi-eval-loop", d))) cpSync(join(umbrella, "pi-eval-loop", d), join(sides.final, "pi-eval-loop", d), { recursive: true });
  cpSync(join(umbrella, "pi-eval-loop/package.json"), join(sides.final, "pi-eval-loop/package.json"));
  const version = execFileSync(process.execPath, [tsc, "-v"]).toString().trim();
  const summary = { base, tsc: version, scope: dirs.map(d => `pi-eval-loop/${d}`), configs: {} };
  /** @type {Array<[string, { types: string[], typeRoots?: string[] }]>} */
  const configs = [["plain", { types: [] }], ["node", { types: ["node"], typeRoots: [typeRoot] }]];
  for (const [config, types] of configs) {
    const result = {};
    for (const [side, dir] of Object.entries(sides)) {
      const tsconfig = join(dir, `tsconfig.${config}.json`);
      writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true, ...types }, include: dirs.map(d => `pi-eval-loop/${d}/**/*.mjs`).concat(["pi-eval-loop/extension/**/*.js"]) }));
      const run = spawnSync(process.execPath, [tsc, "-p", tsconfig, "--pretty", "false"], { cwd: dir, maxBuffer: 1 << 28 });
      const text = run.stdout.toString();
      writeFileSync(join(out, `${config}-${side}.txt`), text);
      const diags = text.split("\n").filter(l => / error TS\d+:/.test(l)).map(l => { const m = l.match(/^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/); return m ? `${m[1]} | ${m[2]} | ${m[3]}` : l; });
      result[side] = { total: diags.length, syntax: diags.filter(d => / \| TS1\d{3} \| /.test(d)).length, diags };
    }
    const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
    const b = count(result.base.diags), f = count(result.final.diags);
    const delta = (from, to) => [...to].flatMap(([k, n]) => Array(Math.max(0, n - (from.get(k) ?? 0))).fill(k));
    const added = delta(b, f), resolved = delta(f, b);
    const byFile = (xs) => Object.fromEntries([...count(xs.map(x => x.split(" | ")[0]))].sort());
    summary.configs[config] = { base: { total: result.base.total, syntax: result.base.syntax }, final: { total: result.final.total, syntax: result.final.syntax }, added: added.length, resolved: resolved.length, addedByFile: byFile(added), resolvedByFile: byFile(resolved), finalByFile: byFile(result.final.diags) };
    writeFileSync(join(out, `${config}-added.txt`), added.join("\n") + (added.length ? "\n" : ""));
    writeFileSync(join(out, `${config}-resolved.txt`), resolved.join("\n") + (resolved.length ? "\n" : ""));
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(Object.fromEntries(Object.entries(summary.configs).map(([k, v]) => [k, { base: v.base, final: v.final, added: v.added, resolved: v.resolved, addedByFile: v.addedByFile }])), null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }

#!/usr/bin/env bun
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "dist", "bin");

interface Target {
  name: string;
  entry: string;
  description: string;
}

const targets: Target[] = [
  { name: "pika", entry: "apps/pika/src/bin.ts", description: "single entrypoint" },
];

// Optional native addons are loaded defensively at runtime; keep them out of the bundle.
const external = ["bufferutil", "utf-8-validate", "koffi"];
const crossTarget = process.env.PIKA_BUN_TARGET;

async function compile(target: Target): Promise<string> {
  const outputPath = path.join(outDir, target.name);
  const args = [
    "build",
    target.entry,
    "--compile",
    "--outfile",
    outputPath,
    ...external.flatMap((name) => ["--external", name]),
  ];
  if (crossTarget !== undefined && crossTarget.length > 0) {
    args.push("--target", crossTarget);
  }
  process.stdout.write(`compiling ${target.description} (${target.name})\n`);
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`bun build --compile failed for ${target.name} (exit ${result.exitCode})`);
  }
  await chmod(outputPath, 0o755);
  return outputPath;
}

async function main(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const target of targets) {
    const outputPath = await compile(target);
    process.stdout.write(`built ${path.relative(root, outputPath)}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const forbiddenImports = {
  schema: [
    "@pika-harness/core",
    "@pika-harness/server",
    "@pika-harness/client",
    "@pika-harness/adapters",
    "@pika-harness/cli",
    "@pika-harness/pika",
  ],
  core: [
    "@pika-harness/server",
    "@pika-harness/client",
    "@pika-harness/adapters",
    "@pika-harness/cli",
    "@pika-harness/pika",
  ],
  adapters: [
    "@pika-harness/server",
    "@pika-harness/client",
    "@pika-harness/cli",
    "@pika-harness/pika",
  ],
  server: ["@pika-harness/client", "@pika-harness/cli", "@pika-harness/pika"],
  client: [
    "@pika-harness/core",
    "@pika-harness/server",
    "@pika-harness/adapters",
    "@pika-harness/cli",
    "@pika-harness/pika",
  ],
  cli: [
    "@pika-harness/core",
    "@pika-harness/server",
    "@pika-harness/adapters",
    "@pika-harness/pika",
  ],
  // apps/pika is the composition root and may import every workspace package.
  pika: [],
};

const files = [];
for (const area of ["packages", "apps"]) {
  for (const name of await listDirectories(area)) {
    await collect(path.join(area, name, "src"), files);
  }
}

const violations = [];

for (const file of files) {
  const source = await readFile(path.join(root, file), "utf8");
  const owner = ownerOf(file);

  source.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const specifiers = [...line.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
    specifiers.push(...[...line.matchAll(/\bimport\s+["']([^"']+)["']/g)].map((match) => match[1]));

    for (const specifier of specifiers) {
      if (forbiddenImports[owner]?.includes(specifier)) {
        violations.push(`${file}:${lineNumber} ${owner} must not import ${specifier}`);
      }
      if (isChildProcess(specifier) && !isSandboxExecutor(file)) {
        violations.push(
          `${file}:${lineNumber} only packages/adapters/src/sandbox may import ${specifier}`,
        );
      }
    }

    if (/\brequire\s*\(/.test(line)) {
      violations.push(`${file}:${lineNumber} use top-level ESM imports, not require()`);
    }
    if (/\bimport\s*\(/.test(line)) {
      violations.push(`${file}:${lineNumber} use top-level imports, not dynamic import()`);
    }
  });
}

if (violations.length > 0) {
  console.error("Package boundary violations:\n");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Package boundary check passed (${files.length} files).`);

function ownerOf(file) {
  return file.split(path.sep)[1];
}

function isChildProcess(specifier) {
  return specifier === "node:child_process" || specifier === "child_process";
}

function isSandboxExecutor(file) {
  return file.startsWith(path.join("packages", "adapters", "src", "sandbox") + path.sep);
}

async function listDirectories(relativeDir) {
  try {
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function collect(relativeDir, out) {
  let entries;
  try {
    entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await collect(relativePath, out);
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(relativePath);
    }
  }
}

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const templatePath = path.join(publicDir, 'service-worker.tmpl.js');
const outputPath = path.join(publicDir, 'service-worker.js');

async function templateExists() {
  try {
    await access(templatePath, constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function readPackageVersion() {
  try {
    const pkgRaw = await readFile(path.join(rootDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    if (typeof pkg.version === 'string' && pkg.version.trim() !== '') {
      return pkg.version.trim();
    }
  } catch (error) {
    // ignore
  }
  return '0.0.0';
}

function readGitSha() {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (sha) {
      return sha;
    }
  } catch (error) {
    // ignore
  }
  return 'nogit';
}

async function generate() {
  if (!(await templateExists())) {
    return;
  }

  const pkgVersion = await readPackageVersion();
  const gitSha = readGitSha();
  const cacheVersion = `cwz-${pkgVersion}-${gitSha}`;

  const template = await readFile(templatePath, 'utf8');
  const generated = template.replace(/__CACHE_VERSION__/g, cacheVersion);
  await writeFile(outputPath, generated, 'utf8');

  console.log(`Generated service worker (${path.relative(rootDir, outputPath)}) with cache version ${cacheVersion}`);
}

generate().catch((error) => {
  console.error('Failed to generate service worker', error);
  process.exitCode = 1;
});

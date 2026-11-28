#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = 'dopingus-build/disk-crate';
export const RELEASE_TAG = 'scanner-assets-v1';
export const ARCHIVE_NAME = 'scanner-assets-v1.tar.gz';
export const ARCHIVE_SHA256 = 'e124fa7bc221839b0b4042f15d2df1e9c90f28aa836e5a12324322a03c30a9f6';
export const DEFAULT_ARCHIVE_URL = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ARCHIVE_NAME}`;

function sha256HexSync(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isSafeRelativeAssetPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[a-z]+:/i.test(relPath)) return false;
  const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return false;
  return true;
}

/**
 * Verify `manifest.json` and every available pack file in `dir`.
 * @param {string} dir
 */
export function verifyManifestFilesOnDisk(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing manifest.json in ${dir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.packs)) {
    throw new Error('Invalid scanner asset manifest schema');
  }

  let verifiedFiles = 0;
  for (const pack of manifest.packs) {
    if (!pack || typeof pack.id !== 'string') {
      throw new Error('Manifest pack missing valid id');
    }
    if (pack.available === false) continue;
    const files = Array.isArray(pack.files) ? pack.files : [];
    for (const f of files) {
      if (!isSafeRelativeAssetPath(f.path)) {
        throw new Error(`Unsafe manifest file path: ${String(f && f.path)}`);
      }
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
        throw new Error(`Invalid sha256 in manifest for ${f.path}`);
      }
      const fullPath = path.join(dir, f.path);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Missing scanner pack file on disk: ${f.path}`);
      }
      const data = fs.readFileSync(fullPath);
      if (Number.isInteger(f.bytes) && data.length !== f.bytes) {
        throw new Error(`Byte size mismatch for ${f.path}: expected ${f.bytes}, got ${data.length}`);
      }
      const actualSha = sha256HexSync(data);
      if (actualSha !== f.sha256) {
        throw new Error(`SHA-256 mismatch for ${f.path}: expected ${f.sha256}, got ${actualSha}`);
      }
      verifiedFiles++;
    }
  }

  return { manifest, verifiedFiles };
}

/**
 * Fetch (or read from `localFile`), verify archive SHA-256 BEFORE extraction,
 * extract to a staging folder, verify manifest + pack files, and populate `outDir`.
 * @param {{ outDir: string, url?: string, localFile?: string, expectedSha256?: string, fetchImpl?: Function, token?: string }} options
 */
export async function fetchAndVerifyScannerAssets(options) {
  const opts = options || {};
  if (!opts.outDir) throw new Error('outDir is required');
  const resolvedOut = path.resolve(opts.outDir);
  const expectedSha = String(opts.expectedSha256 || ARCHIVE_SHA256).toLowerCase();
  const targetUrl = opts.url || DEFAULT_ARCHIVE_URL;
  const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const token = opts.token !== undefined ? opts.token : process.env.GITHUB_TOKEN || '';

  let archiveBytes;
  if (opts.localFile) {
    archiveBytes = fs.readFileSync(path.resolve(opts.localFile));
  } else {
    if (!fetchFn) throw new Error('No fetch implementation available');
    const headers = { 'User-Agent': 'disk-crate-fetch-scanner-assets/1.0' };
    if (token && targetUrl.startsWith('https://api.github.com/')) {
      headers.Authorization = `Bearer ${token}`;
      headers.Accept = 'application/octet-stream';
    }
    const res = await fetchFn(targetUrl, { headers, redirect: 'follow' });
    if (!res || !res.ok) {
      throw new Error(`Failed to fetch scanner assets archive (${res ? res.status : 'network error'}) from ${targetUrl}`);
    }
    archiveBytes = Buffer.from(await res.arrayBuffer());
  }

  const actualArchiveSha = sha256HexSync(archiveBytes);
  if (actualArchiveSha !== expectedSha) {
    throw new Error(`Archive SHA-256 mismatch: expected ${expectedSha}, got ${actualArchiveSha}`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-crate-assets-'));
  try {
    const tmpArchive = path.join(tmpRoot, ARCHIVE_NAME);
    const stageDir = path.join(tmpRoot, 'stage');
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(tmpArchive, archiveBytes);

    const list = execFileSync('tar', ['-tzf', tmpArchive], { encoding: 'utf8' });
    for (const rawEntry of list.split(/\r?\n/)) {
      const entry = rawEntry.trim().replace(/^\.\//, '');
      if (!entry) continue;
      if (entry.startsWith('/') || entry.includes('..')) {
        throw new Error(`Unsafe archive member path rejected: ${rawEntry}`);
      }
    }

    execFileSync('tar', ['-xzf', tmpArchive, '-C', stageDir], { stdio: 'pipe' });
    const verification = verifyManifestFilesOnDisk(stageDir);

    fs.rmSync(resolvedOut, { recursive: true, force: true });
    fs.mkdirSync(resolvedOut, { recursive: true });
    fs.cpSync(stageDir, resolvedOut, { recursive: true });

    return {
      ok: true,
      outDir: resolvedOut,
      archiveSha256: actualArchiveSha,
      verifiedFiles: verification.verifiedFiles,
      manifest: verification.manifest
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function parseCliArgs(argv) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const out = {
    outDir: path.resolve(__dirname, '..', 'scanner-assets', 'v1')
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) out.outDir = argv[++i];
    else if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--file' && argv[i + 1]) out.localFile = argv[++i];
    else if (a === '--sha256' && argv[i + 1]) out.expectedSha256 = argv[++i];
  }
  return out;
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const result = await fetchAndVerifyScannerAssets(args);
  console.log(
    `Verified & extracted scanner assets (${RELEASE_TAG}, ${result.verifiedFiles} pack files, sha256=${result.archiveSha256}) -> ${result.outDir}`
  );
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

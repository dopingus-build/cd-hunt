#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Encode an unsigned integer as LEB128 bytes.
 * @param {number} value
 * @returns {number[]}
 */
function encodeUleb128(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return bytes;
}

/**
 * Wrap a WASM section payload with its section ID and byte length.
 * @param {number} sectionId
 * @param {number[]} payload
 * @returns {number[]}
 */
function makeWasmSection(sectionId, payload) {
  return [sectionId, ...encodeUleb128(payload.length), ...payload];
}

/**
 * Build a minimal valid single-threaded WebAssembly 1.0 runtime shell module
 * exporting `ping() -> i32` (301) and `version() -> i32` (1).
 * @returns {Uint8Array}
 */
export function buildEngineShellWasmBytes() {
  // Section 1 (Type): 1 function signature: () -> i32
  const typeSection = makeWasmSection(1, [0x01, 0x60, 0x00, 0x01, 0x7f]);
  // Section 3 (Function): 2 functions, both using type index 0
  const funcSection = makeWasmSection(3, [0x02, 0x00, 0x00]);
  // Section 7 (Export): 'ping' -> func 0, 'version' -> func 1
  const pingName = Array.from(Buffer.from('ping', 'utf8'));
  const verName = Array.from(Buffer.from('version', 'utf8'));
  const exportSection = makeWasmSection(7, [
    0x02,
    pingName.length,
    ...pingName,
    0x00,
    0x00,
    verName.length,
    ...verName,
    0x00,
    0x01
  ]);
  // Section 10 (Code):
  // - ping(): i32.const 301 (signed LEB128: 0xad, 0x02), end
  // - version(): i32.const 1 (0x01), end
  const bodyPing = [0x00, 0x41, 0xad, 0x02, 0x0b];
  const bodyVer = [0x00, 0x41, 0x01, 0x0b];
  const codeSection = makeWasmSection(10, [
    0x02,
    ...encodeUleb128(bodyPing.length),
    ...bodyPing,
    ...encodeUleb128(bodyVer.length),
    ...bodyVer
  ]);

  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // "\0asm"
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...funcSection,
    ...exportSection,
    ...codeSection
  ]);

  if (typeof WebAssembly !== 'undefined' && !WebAssembly.validate(bytes)) {
    throw new Error('Generated engine-shell.wasm failed WebAssembly.validate');
  }
  return bytes;
}

/**
 * Compute lowercase hex SHA-256 of bytes.
 * @param {Uint8Array|Buffer} buf
 * @returns {string}
 */
export function sha256HexSync(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the schemaVersion 1 scanner asset manifest matching PHASE3_CAMERA_SCANNER.md.
 * @param {Uint8Array} wasmBytes
 */
export function buildScannerManifest(wasmBytes) {
  const bytes = wasmBytes || buildEngineShellWasmBytes();
  const wasmSha = sha256HexSync(bytes);
  return {
    schemaVersion: 1,
    releaseTag: 'scanner-assets-v1',
    packs: [
      {
        id: 'engine-shell',
        title: 'Scanner Engine Shell (Stage 3a)',
        description: 'Minimal single-threaded WASM runtime shell and frame telemetry loop.',
        stage: '3a',
        required: true,
        available: true,
        version: '1.0.0',
        totalBytes: bytes.length,
        files: [
          {
            path: 'engine-shell.wasm',
            bytes: bytes.length,
            contentType: 'application/wasm',
            sha256: wasmSha
          }
        ]
      },
      {
        id: 'barcode-wasm',
        title: 'Barcode / JAN-13 Decoder Pack',
        description: 'Offline EAN-13/JAN-13 WASM fallback for browsers without native BarcodeDetector (Planned Stage 3b).',
        stage: '3b',
        required: false,
        available: false,
        version: 'planned-3b',
        totalBytes: 0,
        files: []
      },
      {
        id: 'catno-ocr',
        title: 'Spine Catalog Number OCR Pack',
        description: 'Compact [A-Z0-9-~] spine & back-insert recognizer for occluded barcodes (Planned Stage 3b).',
        stage: '3b',
        required: false,
        available: false,
        version: 'planned-3b',
        totalBytes: 0,
        files: []
      },
      {
        id: 'cover-embed',
        title: 'Front-Cover Visual Matcher Pack',
        description: 'Closed-set int8 vision embeddings with dual full/obi-crop index (Planned Stage 3c).',
        stage: '3c',
        required: false,
        available: false,
        version: 'planned-3c',
        totalBytes: 0,
        files: []
      }
    ]
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      out.outDir = argv[++i];
    } else if (arg === '--tar' && argv[i + 1]) {
      out.tarPath = argv[++i];
    }
  }
  return out;
}

export async function runCli(argv = process.argv.slice(2)) {
  const { outDir, tarPath } = parseArgs(argv);
  if (!outDir) {
    throw new Error('Usage: node scripts/build-scanner-assets.mjs --out <dir> [--tar <tarPath>]');
  }

  const resolvedOut = path.resolve(outDir);
  fs.mkdirSync(resolvedOut, { recursive: true });

  const wasmBytes = buildEngineShellWasmBytes();
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const pingVal = instance.exports.ping();
  const verVal = instance.exports.version();
  if (pingVal !== 301 || verVal !== 1) {
    throw new Error(`WASM self-check failed: ping=${pingVal}, version=${verVal}`);
  }

  const manifest = buildScannerManifest(wasmBytes);
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';

  fs.writeFileSync(path.join(resolvedOut, 'engine-shell.wasm'), wasmBytes);
  fs.writeFileSync(path.join(resolvedOut, 'manifest.json'), manifestJson, 'utf8');

  const checksumLines = [
    `${sha256HexSync(wasmBytes)}  engine-shell.wasm`,
    `${sha256HexSync(Buffer.from(manifestJson, 'utf8'))}  manifest.json`
  ];
  fs.writeFileSync(path.join(resolvedOut, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n', 'utf8');

  console.log(`Built engine-shell.wasm (${wasmBytes.length} bytes, ping=${pingVal}, version=${verVal}) into ${resolvedOut}`);

  if (tarPath) {
    const resolvedTar = path.resolve(tarPath);
    fs.mkdirSync(path.dirname(resolvedTar), { recursive: true });
    execFileSync(
      'tar',
      ['-czf', resolvedTar, '-C', resolvedOut, 'manifest.json', 'engine-shell.wasm', 'SHA256SUMS.txt'],
      { env: Object.assign({}, process.env, { COPYFILE_DISABLE: '1' }), stdio: 'inherit' }
    );
    const list = execFileSync('tar', ['-tzf', resolvedTar], { encoding: 'utf8' });
    if (list.includes('._')) {
      throw new Error(`Archive unexpectedly contains macOS AppleDouble files:\n${list}`);
    }
    const tarSha = sha256HexSync(fs.readFileSync(resolvedTar));
    console.log(`TAR_PATH=${resolvedTar}`);
    console.log(`ARCHIVE_SHA256=${tarSha}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

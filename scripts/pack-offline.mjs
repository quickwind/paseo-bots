// Packs the plugin as a zip of its source files, for installing on a machine with no internet.
// The daemon compiles the plugin when it starts, so nothing is built here and nothing is downloaded:
// unzip, then `irix plugin install <folder>` (or `paseo plugin install <folder>`).
//
// Usage: node scripts/pack-offline.mjs [--out <dir>]

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// What the plugin needs to run, plus its licence and docs. Tests, scripts and dev tooling stay out.
const INCLUDE = [
  "paseo-plugin.json",
  "package.json",
  "tsconfig.json",
  "index.client.tsx",
  "index.server.ts",
  "client",
  "server",
  "shared",
  "docs",
  "LICENSE",
  "NOTICE",
  "README.md",
];

function files(entry) {
  const absolute = path.join(root, entry);
  if (!statSync(absolute).isDirectory()) return [entry];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((child) => files(path.posix.join(entry, child.name)));
}

/** DOS date and time, which a zip entry stores. Fixed, so the same files always give the same zip. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const out = path.resolve(outIndex === -1 ? path.join(root, "dist") : (process.argv[outIndex + 1] ?? ""));
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const folder = `bot-crew-${version}`;

  const entries = INCLUDE.flatMap(files)
    .sort()
    .map((name) => ({ name: `${folder}/${name}`, data: readFileSync(path.join(root, name)) }));
  const archive = zip(entries);

  mkdirSync(out, { recursive: true });
  const target = path.join(out, `${folder}.zip`);
  writeFileSync(target, archive);
  const sha = createHash("sha256").update(archive).digest("hex");
  writeFileSync(`${target}.sha256`, `${sha}  ${path.basename(target)}\n`);
  process.stdout.write(`${target}\n  ${entries.length} files, ${archive.length} bytes\n  sha256 ${sha}\n`);
}

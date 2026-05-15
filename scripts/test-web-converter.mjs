import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { convertQxFiles, makeFileLike } from "../docs/converter.browser.js";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

const sourceDir = path.resolve(process.argv[2] || "qx 抓包原始文件示例");
const rootName = path.basename(sourceDir);
const files = [];

for (const dirent of await fs.readdir(sourceDir, { withFileTypes: true })) {
  if (!dirent.isDirectory() || !/^\d+$/.test(dirent.name)) continue;
  const requestDir = path.join(sourceDir, dirent.name);
  for (const fileName of await fs.readdir(requestDir)) {
    const fullPath = path.join(requestDir, fileName);
    const bytes = new Uint8Array(await fs.readFile(fullPath));
    files.push(makeFileLike(`${rootName}/${dirent.name}/${fileName}`, bytes));
  }
}

const result = await convertQxFiles(files, {
  async decompress(bytes, format) {
    if (format === "gzip") return new Uint8Array(await gunzip(bytes));
    if (format === "deflate") return new Uint8Array(await inflate(bytes));
    if (format === "deflate-raw") return new Uint8Array(await inflateRaw(bytes));
    throw new Error(`unsupported format ${format}`);
  },
  async decompressBrotli(bytes) {
    return new Uint8Array(await brotliDecompress(bytes));
  },
});

if (result.stats.requests !== 30) {
  throw new Error(`expected 30 requests, got ${result.stats.requests}`);
}

if (result.stats.decodedResponses !== 19) {
  throw new Error(`expected 19 decoded responses, got ${result.stats.decodedResponses}`);
}

if (!result.report.includes('"status": "success"')) {
  throw new Error("expected formatted response JSON in report");
}

console.log(
  `web converter ok: ${result.stats.requests} requests, ${result.stats.decodedResponses} decoded, ${result.report.length} chars`
);

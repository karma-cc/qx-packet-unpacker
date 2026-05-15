const EXPECTED_FILE_NAMES = new Set([
  "basic",
  "request_headers",
  "response_headers",
  "request_body",
  "response_body",
]);

const decoder = new TextDecoder("utf-8", { fatal: false });
const latinDecoder = new TextDecoder("iso-8859-1", { fatal: false });
const encoder = new TextEncoder();

export async function convertQxFiles(files, options = {}) {
  const groups = await groupCaptureFiles(files);
  if (groups.records.length === 0) {
    throw new Error("没有找到 qx 请求编号文件夹，例如 1/basic、1/response_body。");
  }

  const records = [];
  for (const group of groups.records) {
    records.push(await parseRecord(group, options));
  }

  const report = renderReport(groups.sourceName, records);
  return {
    report,
    records,
    stats: summarize(records),
    fileName: `${timestampForFile()}_qx_可读整理.txt`,
  };
}

async function groupCaptureFiles(files) {
  const byId = new Map();
  let sourceName = "浏览器选择的目录";

  for (const file of Array.from(files)) {
    const rawPath = file.webkitRelativePath || file.relativePath || file.name;
    const parts = rawPath.split("/").filter(Boolean);
    if (parts.length > 1) sourceName = parts[0];

    const fileName = parts.at(-1);
    if (!EXPECTED_FILE_NAMES.has(fileName)) continue;

    const idIndex = parts.findIndex((part) => /^\d+$/.test(part));
    if (idIndex < 0) continue;

    const id = parts[idIndex];
    if (!byId.has(id)) byId.set(id, { id: Number(id), files: new Map() });
    byId.get(id).files.set(fileName, file);
  }

  const records = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  return { sourceName, records };
}

async function parseRecord(group, options) {
  const [basic, requestHeadersText, responseHeadersText, requestBodyRaw, responseBodyRaw] =
    await Promise.all([
      readFileText(group.files.get("basic")),
      readFileText(group.files.get("request_headers")),
      readFileText(group.files.get("response_headers")),
      readFileBytes(group.files.get("request_body")),
      readFileBytes(group.files.get("response_body")),
    ]);

  const requestHeaders = parseHeaders(requestHeadersText);
  const responseHeaders = parseHeaders(responseHeadersText);
  const requestLine = firstNonEmptyLine(requestHeadersText);
  const responseLine = firstNonEmptyLine(responseHeadersText);
  const method = requestLine?.split(/\s+/)[0] || "";
  const status = responseLine?.match(/\s(\d{3})(?:\s|$)/)?.[1] || "";

  const requestBody = await decodeBody(requestBodyRaw, requestHeaders, {
    isResponse: false,
    ...options,
  });
  const responseBody = await decodeBody(responseBodyRaw, responseHeaders, {
    isResponse: true,
    ...options,
  });

  return {
    id: group.id,
    basic: basic.trim(),
    method,
    status,
    requestLine,
    responseLine,
    requestHeadersText: normalizeLineEndings(requestHeadersText).trimEnd(),
    responseHeadersText: normalizeLineEndings(responseHeadersText).trimEnd(),
    requestBody,
    responseBody,
  };
}

async function decodeBody(raw, headers, options) {
  if (!raw || raw.length === 0) {
    return {
      rawBytes: 0,
      decodedBytes: 0,
      decodedData: new Uint8Array(),
      contentType: "",
      mimeType: "",
      isImage: false,
      text: "",
      display: "(空)",
      note: "empty",
      encodingSteps: [],
    };
  }

  let bytes = raw;
  const steps = [];
  const transferEncoding = headerValue(headers, "transfer-encoding").toLowerCase();
  if (options.isResponse && transferEncoding.includes("chunked")) {
    const chunked = stripChunkedEncoding(bytes);
    if (chunked.ok) {
      bytes = chunked.body;
      steps.push("dechunked");
    } else {
      steps.push(`chunked parse failed: ${chunked.error}`);
    }
  }

  const contentEncoding = headerValue(headers, "content-encoding").toLowerCase();
  try {
    if (contentEncoding.includes("br")) {
      bytes = await decompressBrotli(bytes, options);
      steps.push("brotli");
    } else if (contentEncoding.includes("gzip")) {
      bytes = await decompressWithStream(bytes, "gzip", options);
      steps.push("gzip");
    } else if (contentEncoding.includes("deflate")) {
      try {
        bytes = await decompressWithStream(bytes, "deflate", options);
      } catch {
        bytes = await decompressWithStream(bytes, "deflate-raw", options);
      }
      steps.push("deflate");
    }
  } catch (error) {
    steps.push(`${contentEncoding || "compressed"} decompress failed: ${error.message}`);
  }

  const textInfo = bufferToReadableText(bytes, headers);
  const contentType = headerValue(headers, "content-type");
  const mimeType = contentType.split(";")[0].trim().toLowerCase() || detectImageMime(bytes);
  const isImage = mimeType.startsWith("image/");
  return {
    rawBytes: raw.length,
    decodedBytes: bytes.length,
    decodedData: bytes,
    contentType,
    mimeType,
    isImage,
    text: textInfo.text,
    display: isImage ? imageDisplay(bytes, mimeType) : textInfo.display,
    note: isImage ? "image-base64" : textInfo.note,
    encodingSteps: steps,
  };
}

async function decompressWithStream(bytes, format, options) {
  if (options.decompress) {
    return options.decompress(bytes, format);
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持 DecompressionStream，请使用最新版 Chrome、Edge 或 Safari。");
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressBrotli(bytes, options) {
  if (options.decompressBrotli) {
    return options.decompressBrotli(bytes);
  }

  const brotli = await import("./vendor/brotli-wasm/index.web.js").then((module) => module.default);
  return brotli.decompress(bytes);
}

export function stripChunkedEncoding(buffer) {
  let offset = 0;
  const chunks = [];

  while (offset < buffer.length) {
    const lineEnd = indexOfCRLF(buffer, offset);
    if (lineEnd < 0) {
      return { ok: false, error: "missing chunk size CRLF" };
    }

    const sizeLine = asciiFromBytes(buffer.subarray(offset, lineEnd)).trim();
    const size = Number.parseInt(sizeLine.split(";")[0], 16);
    if (!Number.isFinite(size)) {
      return { ok: false, error: `invalid chunk size '${sizeLine}'` };
    }

    offset = lineEnd + (buffer[lineEnd] === 13 ? 2 : 1);
    if (size === 0) {
      return { ok: true, body: concatBytes(chunks) };
    }

    if (offset + size > buffer.length) {
      return { ok: false, error: "chunk extends beyond body" };
    }

    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;

    if (buffer[offset] === 13 && buffer[offset + 1] === 10) {
      offset += 2;
    } else if (buffer[offset] === 10) {
      offset += 1;
    }
  }

  return { ok: true, body: concatBytes(chunks) };
}

function indexOfCRLF(buffer, start) {
  for (let i = start; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
  }
  for (let i = start; i < buffer.length; i += 1) {
    if (buffer[i] === 10) return i;
  }
  return -1;
}

function bufferToReadableText(buffer, headers) {
  if (buffer.length === 0) {
    return { text: "", display: "(空)", note: "empty" };
  }

  const charset = headerValue(headers, "content-type").match(/charset=([^;\s]+)/i)?.[1];
  const text = decodeText(buffer, charset);
  const binaryScore = countSuspiciousChars(text) / Math.max(text.length, 1);
  const looksBinary = binaryScore > 0.08;

  if (looksBinary) {
    return {
      text,
      display: `[二进制内容 ${buffer.length} bytes，Base64]\n${bytesToBase64(buffer)}`,
      note: "binary-base64",
    };
  }

  const pretty = prettyPrintText(text);
  return {
    text: pretty,
    display: pretty || "(空)",
    note: pretty === text ? "text" : "pretty-json",
  };
}

function imageDisplay(buffer, mimeType) {
  return `[图片内容 ${buffer.length} bytes，${mimeType || "unknown"}，Base64]\n${bytesToBase64(buffer)}`;
}

function detectImageMime(bytes) {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((value, index) => bytes[index] === value)) return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = asciiFromBytes(bytes.subarray(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = asciiFromBytes(bytes.subarray(0, 4));
    const webp = asciiFromBytes(bytes.subarray(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  if (bytes.length >= 4) {
    const avif = asciiFromBytes(bytes.subarray(4, 12));
    if (avif === "ftypavif") return "image/avif";
  }
  return "";
}

function prettyPrintText(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!/^[\[{]/.test(trimmed)) return normalizeLineEndings(text).trim();

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return normalizeLineEndings(text).trim();
  }
}

function renderReport(sourceName, records) {
  const lines = [];
  lines.push("QX 抓包自动解包整理");
  lines.push(`源目录: ${sourceName}`);
  lines.push(`请求总数: ${records.length}`);
  lines.push(
    "说明: 全部处理都在浏览器本机完成；response_body 会按 Transfer-Encoding 先去 chunk，再按 Content-Encoding 解压 gzip/br/deflate；JSON 会自动格式化。"
  );
  lines.push("");

  for (const record of records) {
    const titleParts = [
      `#${record.id}`,
      record.method || "REQUEST",
      record.status ? `HTTP ${record.status}` : "",
      record.basic,
    ].filter(Boolean);

    lines.push("=".repeat(96));
    lines.push(titleParts.join("  "));
    lines.push("-".repeat(96));
    lines.push(`URL: ${record.basic || "(未知)"}`);
    lines.push(`请求: ${record.requestLine || "(无请求行)"}`);
    lines.push(`响应: ${record.responseLine || "(无响应行)"}`);
    lines.push("");
    lines.push("[请求头]");
    lines.push(record.requestHeadersText || "(空)");
    lines.push("");
    lines.push("[请求体]");
    lines.push(bodyMeta(record.requestBody));
    lines.push(record.requestBody.display);
    lines.push("");
    lines.push("[响应头]");
    lines.push(record.responseHeadersText || "(空)");
    lines.push("");
    lines.push("[响应体]");
    lines.push(bodyMeta(record.responseBody));
    lines.push(record.responseBody.display);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function summarize(records) {
  const decodedResponses = records.filter((record) =>
    record.responseBody.encodingSteps.some((step) => /gzip|brotli|deflate/.test(step))
  ).length;
  const jsonBodies = records.filter(
    (record) => record.requestBody.note === "pretty-json" || record.responseBody.note === "pretty-json"
  ).length;
  const binaryBodies = records.filter(
    (record) => record.requestBody.note === "binary-base64" || record.responseBody.note === "binary-base64"
  ).length;

  return {
    requests: records.length,
    decodedResponses,
    jsonBodies,
    binaryBodies,
  };
}

function bodyMeta(body) {
  const steps = body.encodingSteps.length ? body.encodingSteps.join(" -> ") : "none";
  return `原始 ${body.rawBytes} bytes / 解包后 ${body.decodedBytes} bytes / 类型 ${body.note} / 处理 ${steps}`;
}

function parseHeaders(text) {
  const headers = new Map();
  for (const line of normalizeLineEndings(text).split("\n").slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
  }
  return headers;
}

function headerValue(headers, key) {
  return headers.get(key.toLowerCase()) || "";
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function firstNonEmptyLine(text) {
  return normalizeLineEndings(text)
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
}

async function readFileText(file) {
  if (!file) return "";
  return decoder.decode(await readFileBytes(file));
}

async function readFileBytes(file) {
  if (!file) return new Uint8Array();
  return new Uint8Array(await file.arrayBuffer());
}

function decodeText(buffer, charset) {
  const normalized = charset?.replaceAll("\"", "").toLowerCase();
  if (normalized === "latin-1" || normalized === "latin1" || normalized === "iso-8859-1") {
    return latinDecoder.decode(buffer);
  }
  return decoder.decode(buffer);
}

function countSuspiciousChars(text) {
  let count = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code < 9 || (code > 13 && code < 32)) && code !== 0) count += 1;
    if (char === "\uFFFD") count += 1;
  }
  return count;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function asciiFromBytes(bytes) {
  return String.fromCharCode(...bytes);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function makeFileLike(relativePath, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : encoder.encode(String(bytes));
  return {
    name: relativePath.split("/").at(-1),
    webkitRelativePath: relativePath,
    async arrayBuffer() {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    },
  };
}

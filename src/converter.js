const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

const BODY_NAMES = new Set(["request_body", "response_body"]);
const HEADER_NAMES = new Set(["request_headers", "response_headers"]);
const EXPECTED_NAMES = new Set(["basic", ...BODY_NAMES, ...HEADER_NAMES]);

async function convertCaptureDirectory(sourceDir, options = {}) {
  const { source, records } = await parseCaptureSource(sourceDir);
  const report = renderReport(source, records, options);
  const adRewrite = generateQxAdRewrite(records, source);
  const outputPath =
    options.outputPath ||
    path.join(source, `${timestampForFile()}_qx_可读整理.txt`);

  await fs.writeFile(outputPath, report, "utf8");
  return {
    outputPath,
    report,
    adRewrite,
    stats: summarize(records),
    records,
  };
}

async function parseCaptureDirectory(sourceDir) {
  const source = path.resolve(sourceDir);
  const entries = await fs.readdir(source, { withFileTypes: true });
  const requestDirs = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));

  if (requestDirs.length === 0) {
    throw new Error("没有找到 qx 请求编号文件夹，例如 1/basic、1/response_body。");
  }

  const records = [];
  for (const dirName of requestDirs) {
    records.push(await parseRecord(source, dirName));
  }
  return { source, records };
}

async function analyzeCaptureDirectoryForQxAdRewrite(sourceDir, options = {}) {
  const { source, records } = await parseCaptureSource(sourceDir);
  const adRewrite = generateQxAdRewrite(records, source);
  const outputPath =
    options.outputPath ||
    path.join(path.resolve(sourceDir), `${timestampForFile()}_qx_去广告重写.txt`);

  await fs.writeFile(outputPath, adRewrite.text, "utf8");
  return {
    outputPath,
    adRewrite,
    stats: summarize(records),
    records,
  };
}

async function parseCaptureSource(sourcePath) {
  const source = path.resolve(sourcePath);
  const stat = await fs.stat(source);
  if (stat.isDirectory()) return parseCaptureDirectory(source);

  const text = await fs.readFile(source, "utf8");
  const records = parseTextCaptureRecords(text);
  if (records.length === 0) {
    throw new Error("没有从文本抓包中解析到请求。请上传包含 URL、Request Headers、Response Headers 的抓包 txt。");
  }
  return { source, records };
}

function parseTextCaptureRecords(text) {
  const normalized = normalizeLineEndings(text);
  if (normalized.includes(">>> 请求 #")) return parseHttpTrafficText(normalized);
  if (normalized.includes("文件整理输出（单文件可分享版）")) return parseSingleFileReportText(normalized);
  return [];
}

function parseHttpTrafficText(text) {
  const blocks = text.split(/(?=^\s*>>>\s*请求\s*#\d+)/m).filter((block) => /^\s*>>>\s*请求\s*#\d+/m.test(block));
  return blocks.map((block, index) => {
    const id = Number(block.match(/^\s*>>>\s*请求\s*#(\d+)/m)?.[1] || index + 1);
    const basic = block.match(/^\s*URL:\s*(.+)$/m)?.[1]?.trim() || "";
    const method = block.match(/^\s*Method:\s*(.+)$/m)?.[1]?.trim() || firstNonEmptyLine(sectionText(block, "Request Headers"))?.split(/\s+/)[0] || "";
    const requestHeadersText = sectionText(block, "Request Headers");
    const responseStatus = block.match(/HTTP\/\d(?:\.\d)?\s+\d{3}[^\n]*/)?.[0] || "";
    const responseHeadersText = [responseStatus, sectionText(block, "Response Headers")].filter(Boolean).join("\n");
    const requestBodyText = stripLeadingBodySize(sectionText(block, "Request Body"));
    const responseBodyText = stripLeadingBodySize(sectionText(block, "Response Body"));
    const requestHeaders = parseHeaders(requestHeadersText);
    const responseHeaders = parseHeaders(responseHeadersText);
    return makeTextRecord({
      id,
      basic,
      method,
      status: responseStatus.match(/\s(\d{3})(?:\s|$)/)?.[1] || "",
      requestLine: firstNonEmptyLine(requestHeadersText),
      responseLine: firstNonEmptyLine(responseHeadersText),
      requestHeadersText,
      responseHeadersText,
      requestHeaders,
      responseHeaders,
      requestBodyText,
      responseBodyText,
    });
  }).filter((record) => record.basic);
}

function parseSingleFileReportText(text) {
  const entries = text.split(/=+\s*明显分割线\s*=+/).map(parseSingleFileEntry).filter(Boolean);
  const byId = new Map();
  for (const entry of entries) {
    const match = entry.fileName.match(/^(\d+)\/(basic|request_headers|response_headers|request_body|response_body)$/);
    if (!match) continue;
    const [, id, name] = match;
    if (!byId.has(id)) byId.set(id, { id: Number(id) });
    byId.get(id)[name] = entry.content;
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id).map((item) => {
    const requestHeadersText = item.request_headers || "";
    const responseHeadersText = item.response_headers || "";
    const requestHeaders = parseHeaders(requestHeadersText);
    const responseHeaders = parseHeaders(responseHeadersText);
    const responseLine = firstNonEmptyLine(responseHeadersText) || "";
    return makeTextRecord({
      id: item.id,
      basic: (item.basic || "").trim(),
      method: firstNonEmptyLine(requestHeadersText)?.split(/\s+/)[0] || "",
      status: responseLine.match(/\s(\d{3})(?:\s|$)/)?.[1] || "",
      requestLine: firstNonEmptyLine(requestHeadersText),
      responseLine,
      requestHeadersText,
      responseHeadersText,
      requestHeaders,
      responseHeaders,
      requestBodyText: item.request_body || "",
      responseBodyText: item.response_body || "",
    });
  }).filter((record) => record.basic);
}

function parseSingleFileEntry(entry) {
  const fileName = entry.match(/文件:\s*(.+)$/m)?.[1]?.trim();
  const content = entry.match(/---- 原始文本内容开始 ----\n([\s\S]*?)\n---- 原始文本内容结束 ----/)?.[1] || "";
  return fileName ? { fileName, content } : null;
}

function sectionText(block, title) {
  const pattern = new RegExp(`── ${escapeRegExp(title)}(?: \\([^\\n]*\\))? ──\\n([\\s\\S]*?)(?=\\n\\s*── |\\n\\s*▬▬|\\n\\s*▓|$)`);
  return normalizeLineEndings(block.match(pattern)?.[1] || "").trim();
}

function stripLeadingBodySize(text) {
  return text.replace(/^\s*\d+\s*\r?\n/, "").trim();
}

function makeTextRecord(data) {
  return {
    id: data.id,
    basic: data.basic,
    method: data.method,
    status: data.status,
    requestLine: data.requestLine,
    responseLine: data.responseLine,
    requestHeadersText: normalizeLineEndings(data.requestHeadersText || "").trimEnd(),
    responseHeadersText: normalizeLineEndings(data.responseHeadersText || "").trimEnd(),
    requestHeaders: data.requestHeaders,
    responseHeaders: data.responseHeaders,
    requestBody: textBody(data.requestBodyText),
    responseBody: textBody(data.responseBodyText),
  };
}

function textBody(text) {
  const display = prettyPrintText(normalizeLineEndings(text || "").trim());
  return {
    rawBytes: Buffer.byteLength(text || ""),
    decodedBytes: Buffer.byteLength(display || ""),
    text: display,
    display: display || "(空)",
    note: display ? (/^[\[{]/.test(display.trim()) ? "pretty-json" : "text") : "empty",
    encodingSteps: [],
  };
}

async function parseRecord(source, dirName) {
  const dir = path.join(source, dirName);
  const [basic, requestHeadersText, responseHeadersText, requestBodyRaw, responseBodyRaw] =
    await Promise.all([
      readTextIfExists(path.join(dir, "basic")),
      readTextIfExists(path.join(dir, "request_headers")),
      readTextIfExists(path.join(dir, "response_headers")),
      readBufferIfExists(path.join(dir, "request_body")),
      readBufferIfExists(path.join(dir, "response_body")),
    ]);

  const requestHeaders = parseHeaders(requestHeadersText);
  const responseHeaders = parseHeaders(responseHeadersText);
  const requestLine = firstNonEmptyLine(requestHeadersText);
  const responseLine = firstNonEmptyLine(responseHeadersText);
  const method = requestLine?.split(/\s+/)[0] || "";
  const status = responseLine?.match(/\s(\d{3})(?:\s|$)/)?.[1] || "";

  const requestBody = await decodeBody(requestBodyRaw, requestHeaders, {
    isResponse: false,
  });
  const responseBody = await decodeBody(responseBodyRaw, responseHeaders, {
    isResponse: true,
  });

  return {
    id: Number(dirName),
    basic: basic.trim(),
    method,
    status,
    requestLine,
    responseLine,
    requestHeadersText: normalizeLineEndings(requestHeadersText).trimEnd(),
    responseHeadersText: normalizeLineEndings(responseHeadersText).trimEnd(),
    requestHeaders,
    responseHeaders,
    requestBody,
    responseBody,
  };
}

async function decodeBody(raw, headers, { isResponse }) {
  if (!raw || raw.length === 0) {
    return {
      rawBytes: 0,
      decodedBytes: 0,
      text: "",
      display: "(空)",
      note: "empty",
      encodingSteps: [],
    };
  }

  let bytes = raw;
  const steps = [];
  const transferEncoding = headerValue(headers, "transfer-encoding").toLowerCase();
  if (isResponse && transferEncoding.includes("chunked")) {
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
      bytes = await brotliDecompress(bytes);
      steps.push("brotli");
    } else if (contentEncoding.includes("gzip")) {
      bytes = await gunzip(bytes);
      steps.push("gzip");
    } else if (contentEncoding.includes("deflate")) {
      try {
        bytes = await inflate(bytes);
      } catch {
        bytes = await inflateRaw(bytes);
      }
      steps.push("deflate");
    }
  } catch (error) {
    steps.push(`${contentEncoding || "compressed"} decompress failed: ${error.message}`);
  }

  const textInfo = bufferToReadableText(bytes, headers);
  return {
    rawBytes: raw.length,
    decodedBytes: bytes.length,
    text: textInfo.text,
    display: textInfo.display,
    note: textInfo.note,
    encodingSteps: steps,
  };
}

function stripChunkedEncoding(buffer) {
  let offset = 0;
  const chunks = [];

  while (offset < buffer.length) {
    const lineEnd = indexOfCRLF(buffer, offset);
    if (lineEnd < 0) {
      return { ok: false, error: "missing chunk size CRLF" };
    }

    const sizeLine = buffer.toString("ascii", offset, lineEnd).trim();
    const size = Number.parseInt(sizeLine.split(";")[0], 16);
    if (!Number.isFinite(size)) {
      return { ok: false, error: `invalid chunk size '${sizeLine}'` };
    }

    offset = lineEnd + 2;
    if (size === 0) {
      return { ok: true, body: Buffer.concat(chunks) };
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

  return { ok: true, body: Buffer.concat(chunks) };
}

function indexOfCRLF(buffer, start) {
  for (let i = start; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
  }
  return buffer.indexOf(10, start);
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
      display: `[二进制内容 ${buffer.length} bytes，Base64]\n${buffer.toString("base64")}`,
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

function decodeText(buffer, charset) {
  const normalized = charset?.replaceAll("\"", "").toLowerCase();
  if (!normalized || normalized === "utf-8" || normalized === "utf8") {
    return buffer.toString("utf8");
  }
  if (normalized === "latin-1" || normalized === "latin1" || normalized === "iso-8859-1") {
    return buffer.toString("latin1");
  }
  return buffer.toString("utf8");
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

function renderReport(source, records) {
  const lines = [];
  lines.push("QX 抓包自动解包整理");
  lines.push(`源目录: ${source}`);
  lines.push(`请求总数: ${records.length}`);
  lines.push(
    "说明: response_body 会按 Transfer-Encoding 先去 chunk，再按 Content-Encoding 解压 gzip/br/deflate；JSON 会自动格式化。"
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

function generateQxAdRewrite(records, sourceName = "QX 抓包") {
  const hostCounts = countBy(records, (record) => parseUrl(record.basic)?.hostname || "");
  const candidates = records
    .map((record) => analyzeAdCandidate(record, hostCounts))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.host.localeCompare(b.host) || a.rule.localeCompare(b.rule));
  const unique = dedupeCandidates(candidates);
  const hosts = Array.from(new Set(unique.map((candidate) => candidate.host))).sort();
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const lines = [];

  lines.push("# Quantumult X 去广告重写");
  lines.push(`# 来源: ${sourceName}`);
  lines.push(`# 生成时间: ${now}`);
  lines.push(`# 命中候选: ${unique.length}`);
  lines.push("# 说明: 规则按本次抓包中的实际 host/path/响应特征提炼，优先精确命中真实请求。");
  lines.push("");
  lines.push("[rewrite_local]");

  if (unique.length === 0) {
    lines.push("# 未找到足够明确的拦截候选。");
  } else {
    for (const candidate of unique) {
      lines.push(
        `# #${candidate.id} ${candidate.method || "REQ"} score ${candidate.score} ${candidate.reason}`
      );
      lines.push(`${candidate.rule} url ${candidate.action}`);
    }
  }

  lines.push("");
  lines.push("[mitm]");
  lines.push(`hostname = ${hosts.length ? hosts.join(", ") : "%APPEND%"}`);
  lines.push("");

  return {
    text: `${lines.join("\n")}\n`,
    stats: {
      candidates: unique.length,
      hosts: hosts.length,
    },
  };
}

function analyzeAdCandidate(record, hostCounts) {
  const url = parseUrl(record.basic);
  if (!url) return null;

  const text = [
    url.hostname,
    url.pathname,
    url.search,
    record.requestHeadersText,
    record.responseHeadersText,
    record.requestBody?.display,
    record.responseBody?.display,
  ]
    .join("\n")
    .toLowerCase();
  const reasons = [];
  let score = 0;

  const hostSignals = matchSignals(url.hostname, HOST_HINTS);
  if (hostSignals.length) {
    score += hostSignals.length * 3;
    reasons.push(`host:${hostSignals.slice(0, 4).join("/")}`);
  }

  const pathSignals = matchSignals(`${url.pathname}${url.search}`, PATH_HINTS);
  if (pathSignals.length) {
    score += pathSignals.length * 2;
    reasons.push(`path:${pathSignals.slice(0, 4).join("/")}`);
  }

  const bodySignals = matchSignals(text, BODY_HINTS);
  if (bodySignals.length) {
    score += Math.min(bodySignals.length, 4);
    reasons.push(`body:${bodySignals.slice(0, 4).join("/")}`);
  }

  const hostCount = hostCounts.get(url.hostname) || 0;
  if (hostCount >= 2) {
    score += 1;
    reasons.push(`repeat:${hostCount}`);
  }

  const responseType = headerValue(record.responseHeaders, "content-type").toLowerCase();
  if (responseType.includes("json") || responseType.includes("javascript") || responseType.includes("text/plain")) {
    score += 1;
  }

  if (/^image\//i.test(responseType)) {
    score += 1;
    reasons.push("image");
  }

  if (/^(204|301|302|304|404)$/.test(String(record.status || ""))) {
    score -= 1;
  }

  if (score < 3) return null;

  const hostLevelBlock = hostSignals.length > 0;
  const pathPrefixSegments = choosePathPrefixSegments(url, hostCount, { hostSignals, pathSignals });

  return {
    id: record.id,
    method: record.method,
    host: url.hostname,
    rule: qxUrlRule(url, { hostLevelBlock, pathPrefixSegments }),
    action: qxRejectAction(record),
    score,
    reason: reasons.join(", "),
  };
}

const HOST_HINTS = [
  "ad",
  "ads",
  "adserver",
  "advert",
  "analytics",
  "antifraud",
  "metrics",
  "monitor",
  "report",
  "sdk",
  "telemetry",
  "tracking",
];

const PATH_HINTS = [
  "ad",
  "ads",
  "adver",
  "analytics",
  "app_log",
  "abtest",
  "banner",
  "cloudconf",
  "collect",
  "config",
  "device_register",
  "event",
  "launch",
  "log",
  "metrics",
  "monitor",
  "popup",
  "promotion",
  "report",
  "splash",
  "telemetry",
  "track",
];

const BODY_HINTS = [
  "\"ad\"",
  "\"ads\"",
  "\"adid\"",
  "\"ad_info\"",
  "\"ad_list\"",
  "\"advert",
  "\"analytics",
  "\"banner",
  "\"collect",
  "\"event",
  "\"log",
  "\"promotion",
  "\"report",
  "\"splash",
  "\"track",
];

function matchSignals(text, signals) {
  const normalized = text.toLowerCase();
  return signals.filter((signal) => signalMatches(normalized, signal));
}

function signalMatches(text, signal) {
  if (signal === "ad" || signal === "ads") {
    return new RegExp(`(^|[._\\-/&?=])${signal}($|[._\\-/&?=])`).test(text);
  }
  return text.includes(signal);
}

function choosePathPrefixSegments(url, hostCount, signals) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return 0;
  if (signals.hostSignals.length > 0) return 0;
  if (signals.pathSignals.length > 0) return Math.min(segments.length, segments.length > 2 ? 2 : 1);
  if (hostCount >= 3) return Math.min(segments.length, 2);
  return Math.min(segments.length, 4);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function qxUrlRule(url, { hostLevelBlock = false, pathPrefixSegments = 4 } = {}) {
  const host = escapeRegExp(url.hostname);
  if (hostLevelBlock) return `^https?:\\/\\/${host}\\/`;

  const segments = url.pathname.split("/").filter(Boolean).slice(0, 4);
  const limit = Math.max(1, Math.min(segments.length, pathPrefixSegments || segments.length || 1));
  const prefix = segments.slice(0, limit);
  const path = prefix.length ? `\\/${prefix.map(escapeRegExp).join("\\/")}` : "\\/";
  return `^https?:\\/\\/${host}${path}`;
}

function countBy(records, selector) {
  const counts = new Map();
  for (const record of records) {
    const key = selector(record);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function qxRejectAction(record) {
  const contentType = headerValue(record.responseHeaders, "content-type").toLowerCase();
  const display = record.responseBody?.display?.trim() || "";
  if (contentType.startsWith("image/")) return "reject-img";
  if (contentType.includes("json") || display.startsWith("{")) return "reject-dict";
  if (display.startsWith("[")) return "reject-array";
  return "reject";
}

function dedupeCandidates(candidates) {
  const byRule = new Map();
  for (const candidate of candidates) {
    const existing = byRule.get(candidate.rule);
    if (!existing || candidate.score > existing.score) {
      byRule.set(candidate.rule, candidate);
    }
  }
  return Array.from(byRule.values());
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function bodyMeta(body) {
  const steps = body.encodingSteps.length ? body.encodingSteps.join(" -> ") : "none";
  return `原始 ${body.rawBytes} bytes / 解包后 ${body.decodedBytes} bytes / 类型 ${body.note} / 处理 ${steps}`;
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

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function readBufferIfExists(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
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

async function looksLikeCaptureDirectory(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const numericDir = entries.find((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
    if (!numericDir) return false;
    const files = await fs.readdir(path.join(dir, numericDir.name));
    return files.some((file) => EXPECTED_NAMES.has(file));
  } catch {
    return false;
  }
}

module.exports = {
  convertCaptureDirectory,
  analyzeCaptureDirectoryForQxAdRewrite,
  generateQxAdRewrite,
  looksLikeCaptureDirectory,
  stripChunkedEncoding,
};

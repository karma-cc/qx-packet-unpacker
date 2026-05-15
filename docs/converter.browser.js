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
  const source = await parseCaptureSource(files, options);
  const report = renderReport(source.sourceName, source.records);
  const adRewrite = generateQxAdRewrite(source.records, source.sourceName);
  return {
    report,
    adRewrite,
    records: source.records,
    stats: summarize(source.records),
    fileName: `${timestampForFile()}_qx_可读整理.txt`,
    adRewriteFileName: `${timestampForFile()}_qx_去广告重写.txt`,
  };
}

async function parseCaptureSource(files, options = {}) {
  const list = Array.from(files || []);
  if (list.length === 0) {
    throw new Error("没有选择任何文件。");
  }

  const firstName = (list[0].webkitRelativePath || list[0].name || "").toLowerCase();
  if (isTextCaptureFile(firstName)) {
    return parseTextCaptureFile(list[0]);
  }

  const groups = await groupCaptureFiles(list);
  if (groups.records.length === 0) {
    throw new Error("没有找到 qx 请求编号文件夹，例如 1/basic、1/response_body。");
  }

  return {
    sourceName: groups.sourceName,
    records: await Promise.all(groups.records.map((group) => parseRecord(group, options))),
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

function isTextCaptureFile(name) {
  return name.endsWith(".txt") || name.includes("http_traffic");
}

async function parseTextCaptureFile(file) {
  const text = normalizeLineEndings(await readFileText(file));
  let records = [];
  if (text.includes(">>> 请求 #")) {
    records = parseHttpTrafficText(text);
  } else if (text.includes("文件整理输出（单文件可分享版）")) {
    records = parseSingleFileReportText(text);
  }

  if (records.length === 0) {
    throw new Error("没有从文本抓包中解析到请求。请上传包含 URL、Request Headers、Response Headers 的抓包 txt。");
  }

  return {
    sourceName: file.webkitRelativePath?.split("/")[0] || file.name,
    records,
  };
}

function parseHttpTrafficText(text) {
  return text
    .split(/(?=^\s*>>>\s*请求\s*#\d+)/m)
    .filter((block) => /^\s*>>>\s*请求\s*#\d+/m.test(block))
    .map((block, index) => {
      const id = Number(block.match(/^\s*>>>\s*请求\s*#(\d+)/m)?.[1] || index + 1);
      const basic = block.match(/^\s*URL:\s*(.+)$/m)?.[1]?.trim() || "";
      const requestHeadersText = sectionText(block, "Request Headers");
      const responseHeadersText = [
        block.match(/^\s*HTTP\/\d(?:\.\d)?\s+\d{3}[^\n]*/m)?.[0] || "",
        sectionText(block, "Response Headers"),
      ].filter(Boolean).join("\n");
      const requestHeaders = parseHeaders(requestHeadersText);
      const responseHeaders = parseHeaders(responseHeadersText);
      return makeTextRecord({
        id,
        basic,
        method:
          block.match(/^\s*Method:\s*(.+)$/m)?.[1]?.trim() ||
          firstNonEmptyLine(requestHeadersText)?.split(/\s+/)[0] ||
          "",
        status: responseHeadersText.match(/\s(\d{3})(?:\s|$)/)?.[1] || "",
        requestLine: firstNonEmptyLine(requestHeadersText),
        responseLine: firstNonEmptyLine(responseHeadersText),
        requestHeadersText,
        responseHeadersText,
        requestHeaders,
        responseHeaders,
        requestBodyText: stripLeadingBodySize(sectionText(block, "Request Body")),
        responseBodyText: stripLeadingBodySize(sectionText(block, "Response Body")),
      });
    })
    .filter((record) => record.basic);
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
  return Array.from(byId.values())
    .sort((a, b) => a.id - b.id)
    .map((item) => makeTextRecord({
      id: item.id,
      basic: (item.basic || "").trim(),
      method: firstNonEmptyLine(item.request_headers || "")?.split(/\s+/)[0] || "",
      status: firstNonEmptyLine(item.response_headers || "")?.match(/\s(\d{3})(?:\s|$)/)?.[1] || "",
      requestLine: firstNonEmptyLine(item.request_headers || ""),
      responseLine: firstNonEmptyLine(item.response_headers || ""),
      requestHeadersText: item.request_headers || "",
      responseHeadersText: item.response_headers || "",
      requestHeaders: parseHeaders(item.request_headers || ""),
      responseHeaders: parseHeaders(item.response_headers || ""),
      requestBodyText: item.request_body || "",
      responseBodyText: item.response_body || "",
    }))
    .filter((record) => record.basic);
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
  return text.replace(/^\\s*\\d+\\s*\\r?\\n/, "").trim();
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
  const normalized = normalizeLineEndings(text || "").trim();
  const display = prettyPrintText(normalized);
  return {
    rawBytes: encoder.encode(text || "").length,
    decodedBytes: encoder.encode(display || "").length,
    text: display,
    display: display || "(空)",
    note: display ? (/^[\[{]/.test(display.trim()) ? "pretty-json" : "text") : "empty",
    encodingSteps: [],
  };
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
    requestHeaders,
    responseHeaders,
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

export function generateQxAdRewrite(records, sourceName = "QX 抓包") {
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
  const mime = (record.responseBody?.mimeType || "").toLowerCase();
  const display = record.responseBody?.display?.trim() || "";
  if (mime.startsWith("image/")) return "reject-img";
  if (mime.includes("json") || display.startsWith("{")) return "reject-dict";
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

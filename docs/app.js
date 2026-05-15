import { convertQxFiles } from "./converter.browser.js";

const state = {
  files: [],
  result: null,
  filteredRecords: [],
  selectedId: null,
  activeTab: "summary",
  objectUrls: [],
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  chooseButton: document.querySelector("#chooseButton"),
  convertButton: document.querySelector("#convertButton"),
  downloadButton: document.querySelector("#downloadButton"),
  clearButton: document.querySelector("#clearButton"),
  dropZone: document.querySelector("#dropZone"),
  statusText: document.querySelector("#statusText"),
  txtStatusText: document.querySelector("#txtStatusText"),
  sourcePath: document.querySelector("#sourcePath"),
  preview: document.querySelector("#preview"),
  requestCount: document.querySelector("#requestCount"),
  decodedCount: document.querySelector("#decodedCount"),
  jsonCount: document.querySelector("#jsonCount"),
  binaryCount: document.querySelector("#binaryCount"),
  listCount: document.querySelector("#listCount"),
  searchInput: document.querySelector("#searchInput"),
  requestList: document.querySelector("#requestList"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailContent: document.querySelector("#detailContent"),
  tabs: Array.from(document.querySelectorAll(".tab")),
};

elements.chooseButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => setFiles(elements.fileInput.files));
elements.convertButton.addEventListener("click", parseAndRender);
elements.downloadButton.addEventListener("click", downloadResult);
elements.clearButton.addEventListener("click", clearAll);
elements.searchInput.addEventListener("input", renderRequestList);

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => {
    state.activeTab = tab.dataset.tab;
    renderTabs();
    renderDetail();
  });
}

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
}

elements.dropZone.addEventListener("drop", (event) => {
  const items = Array.from(event.dataTransfer.items || []);
  if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
    elements.statusText.textContent = "拖入目录在部分浏览器受限，请点“选择目录”读取完整文件夹。";
    elements.fileInput.click();
    return;
  }
  setFiles(event.dataTransfer.files);
});

function setFiles(fileList) {
  cleanupUrls();
  state.files = Array.from(fileList || []);
  state.result = null;
  state.filteredRecords = [];
  state.selectedId = null;

  if (state.files.length === 0) {
    clearAll();
    return;
  }

  const firstPath = state.files[0].webkitRelativePath || state.files[0].name;
  const rootName = firstPath.split("/")[0] || "已选择文件";
  elements.sourcePath.value = `${rootName} (${state.files.length} 个文件)`;
  elements.statusText.textContent = "已读取目录，准备解析";
  elements.txtStatusText.textContent = "等待解析";
  elements.preview.textContent = "点击“解析并查看”开始处理。";
  elements.requestList.innerHTML = `<div class="empty-state">点击“解析并查看”后会显示每一条抓包。</div>`;
  elements.detailTitle.textContent = "详情";
  elements.detailSubtitle.textContent = "选择一条请求查看内容";
  elements.detailContent.innerHTML = `<div class="empty-state">解析后可以在这里查看请求和响应。</div>`;
  elements.convertButton.disabled = false;
  elements.downloadButton.disabled = true;
  setStats();
  elements.listCount.textContent = "0 条";
}

async function parseAndRender() {
  if (state.files.length === 0) return;

  setBusy(true);
  cleanupUrls();
  elements.statusText.textContent = "正在本机浏览器内解析...";
  elements.txtStatusText.textContent = "处理中";
  elements.preview.textContent = "处理中，请稍等。";

  try {
    const result = await convertQxFiles(state.files);
    state.result = result;
    state.filteredRecords = result.records;
    state.selectedId = result.records[0]?.id ?? null;
    state.activeTab = "summary";

    setStats(result.stats);
    renderTabs();
    renderRequestList();
    renderDetail();
    elements.preview.textContent = result.report.slice(0, 12000);
    elements.statusText.textContent = `已解析 ${result.stats.requests} 条请求`;
    elements.txtStatusText.textContent = `可下载 ${result.fileName}`;
    elements.downloadButton.disabled = false;
  } catch (error) {
    elements.statusText.textContent = "解析失败";
    elements.txtStatusText.textContent = "解析失败";
    elements.preview.textContent = error?.message || String(error);
    elements.detailContent.innerHTML = `<div class="empty-state error">${escapeHtml(error?.message || String(error))}</div>`;
  } finally {
    setBusy(false);
  }
}

function renderRequestList() {
  if (!state.result) return;

  const query = elements.searchInput.value.trim().toLowerCase();
  state.filteredRecords = state.result.records.filter((record) => {
    const text = `${record.id} ${record.method} ${record.status} ${record.basic}`.toLowerCase();
    return text.includes(query);
  });

  elements.listCount.textContent = `${state.filteredRecords.length} 条`;

  if (state.filteredRecords.length === 0) {
    elements.requestList.innerHTML = `<div class="empty-state">没有匹配的请求。</div>`;
    return;
  }

  elements.requestList.innerHTML = state.filteredRecords
    .map((record) => requestItemHtml(record, record.id === state.selectedId))
    .join("");

  for (const button of elements.requestList.querySelectorAll(".request-item")) {
    button.addEventListener("click", () => {
      state.selectedId = Number(button.dataset.id);
      renderRequestList();
      renderDetail();
    });
  }
}

function requestItemHtml(record, selected) {
  const host = safeHost(record.basic);
  return `
    <button class="request-item ${selected ? "selected" : ""}" data-id="${record.id}">
      <span class="request-line">
        <strong>#${record.id}</strong>
        <em>${escapeHtml(record.method || "REQ")}</em>
        ${record.status ? `<b>${escapeHtml(record.status)}</b>` : ""}
      </span>
      <span class="request-url">${escapeHtml(record.basic || "(未知 URL)")}</span>
      <span class="request-host">${escapeHtml(host)}</span>
    </button>
  `;
}

function renderTabs() {
  for (const tab of elements.tabs) {
    tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
  }
}

function renderDetail() {
  cleanupUrls();

  const record = state.result?.records.find((item) => item.id === state.selectedId);
  if (!record) {
    elements.detailTitle.textContent = "详情";
    elements.detailSubtitle.textContent = "选择一条请求查看内容";
    elements.detailContent.innerHTML = `<div class="empty-state">请选择左侧的一条抓包。</div>`;
    return;
  }

  elements.detailTitle.textContent = `#${record.id} ${record.method || "REQUEST"} ${record.status ? `HTTP ${record.status}` : ""}`;
  elements.detailSubtitle.textContent = record.basic || "(未知 URL)";

  if (state.activeTab === "summary") {
    elements.detailContent.innerHTML = summaryHtml(record);
  } else if (state.activeTab === "requestHeaders") {
    elements.detailContent.innerHTML = codeBlock(record.requestHeadersText || "(空)");
  } else if (state.activeTab === "requestBody") {
    elements.detailContent.innerHTML = bodyHtml(record.requestBody);
  } else if (state.activeTab === "responseHeaders") {
    elements.detailContent.innerHTML = codeBlock(record.responseHeadersText || "(空)");
  } else if (state.activeTab === "responseBody") {
    elements.detailContent.innerHTML = bodyHtml(record.responseBody);
  }
}

function summaryHtml(record) {
  const rows = [
    ["URL", record.basic || "(未知)"],
    ["请求", record.requestLine || "(无请求行)"],
    ["响应", record.responseLine || "(无响应行)"],
    ["请求体", bodySummary(record.requestBody)],
    ["响应体", bodySummary(record.responseBody)],
  ];

  return `
    <div class="summary-grid">
      ${rows
        .map(
          ([label, value]) => `
            <div class="summary-label">${escapeHtml(label)}</div>
            <div class="summary-value">${escapeHtml(value)}</div>
          `
        )
        .join("")}
    </div>
  `;
}

function bodyHtml(body) {
  if (!body || body.note === "empty") {
    return `<div class="empty-state">这个 body 是空的。</div>`;
  }

  const meta = `
    <div class="body-meta">
      <span>原始 ${body.rawBytes} bytes</span>
      <span>解包后 ${body.decodedBytes} bytes</span>
      <span>${escapeHtml(body.mimeType || body.contentType || body.note)}</span>
      <span>${escapeHtml(body.encodingSteps.join(" -> ") || "未压缩")}</span>
    </div>
  `;

  if (body.isImage) {
    const blob = new Blob([body.decodedData], { type: body.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    return `
      ${meta}
      <div class="image-preview">
        <img src="${url}" alt="响应图片预览" />
      </div>
      <details>
        <summary>查看 Base64</summary>
        ${codeBlock(body.display)}
      </details>
    `;
  }

  if (body.note === "binary-base64" || body.note === "image-base64") {
    return `${meta}${codeBlock(body.display)}`;
  }

  return `${meta}${codeBlock(body.display)}`;
}

function bodySummary(body) {
  const steps = body.encodingSteps.length ? body.encodingSteps.join(" -> ") : "none";
  const kind = body.isImage ? `image ${body.mimeType}` : body.note;
  return `原始 ${body.rawBytes} bytes / 解包后 ${body.decodedBytes} bytes / ${kind} / ${steps}`;
}

function codeBlock(text) {
  return `<pre class="detail-code">${escapeHtml(text)}</pre>`;
}

function downloadResult() {
  if (!state.result) return;
  const blob = new Blob([state.result.report], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = state.result.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function clearAll() {
  cleanupUrls();
  state.files = [];
  state.result = null;
  state.filteredRecords = [];
  state.selectedId = null;
  state.activeTab = "summary";
  elements.fileInput.value = "";
  elements.sourcePath.value = "";
  elements.searchInput.value = "";
  elements.convertButton.disabled = true;
  elements.downloadButton.disabled = true;
  elements.statusText.textContent = "等待选择目录";
  elements.txtStatusText.textContent = "可选下载";
  elements.preview.textContent = "选择 qx 抓包目录后，生成的 txt 预览会显示在这里。";
  elements.requestList.innerHTML = `<div class="empty-state">解析后会显示每一条抓包。</div>`;
  elements.detailTitle.textContent = "详情";
  elements.detailSubtitle.textContent = "选择一条请求查看内容";
  elements.detailContent.innerHTML = `<div class="empty-state">选择 qx 抓包目录并解析后，可以在这里逐条预览。</div>`;
  elements.listCount.textContent = "0 条";
  setStats();
  renderTabs();
}

function setBusy(isBusy) {
  elements.chooseButton.disabled = isBusy;
  elements.convertButton.disabled = isBusy || state.files.length === 0;
  elements.clearButton.disabled = isBusy;
}

function setStats(stats = {}) {
  elements.requestCount.textContent = stats.requests ?? 0;
  elements.decodedCount.textContent = stats.decodedResponses ?? 0;
  elements.jsonCount.textContent = stats.jsonBodies ?? 0;
  elements.binaryCount.textContent = stats.binaryBodies ?? 0;
}

function cleanupUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

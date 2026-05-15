import { convertQxFiles } from "./converter.browser.js";

const state = {
  files: [],
  result: null,
  objectUrl: "",
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  chooseButton: document.querySelector("#chooseButton"),
  convertButton: document.querySelector("#convertButton"),
  downloadButton: document.querySelector("#downloadButton"),
  clearButton: document.querySelector("#clearButton"),
  dropZone: document.querySelector("#dropZone"),
  statusText: document.querySelector("#statusText"),
  sourcePath: document.querySelector("#sourcePath"),
  preview: document.querySelector("#preview"),
  requestCount: document.querySelector("#requestCount"),
  decodedCount: document.querySelector("#decodedCount"),
  jsonCount: document.querySelector("#jsonCount"),
  binaryCount: document.querySelector("#binaryCount"),
};

elements.chooseButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => setFiles(elements.fileInput.files));
elements.convertButton.addEventListener("click", convert);
elements.downloadButton.addEventListener("click", downloadResult);
elements.clearButton.addEventListener("click", clearAll);

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
  cleanupUrl();
  state.files = Array.from(fileList || []);
  state.result = null;

  if (state.files.length === 0) {
    clearAll();
    return;
  }

  const firstPath = state.files[0].webkitRelativePath || state.files[0].name;
  const rootName = firstPath.split("/")[0] || "已选择文件";
  elements.sourcePath.value = `${rootName} (${state.files.length} 个文件)`;
  elements.statusText.textContent = "已读取目录，准备解包";
  elements.preview.textContent = "点击“解包并生成 TXT”开始处理。";
  elements.convertButton.disabled = false;
  elements.downloadButton.disabled = true;
  setStats();
}

async function convert() {
  if (state.files.length === 0) return;

  setBusy(true);
  elements.statusText.textContent = "正在本机浏览器内解包...";
  elements.preview.textContent = "处理中，请稍等。";

  try {
    const result = await convertQxFiles(state.files);
    state.result = result;
    setStats(result.stats);
    elements.preview.textContent = result.report.slice(0, 12000);
    elements.statusText.textContent = `已生成 ${result.fileName}`;
    elements.downloadButton.disabled = false;
  } catch (error) {
    elements.statusText.textContent = "转换失败";
    elements.preview.textContent = error?.message || String(error);
  } finally {
    setBusy(false);
  }
}

function downloadResult() {
  if (!state.result) return;
  cleanupUrl();
  const blob = new Blob([state.result.report], { type: "text/plain;charset=utf-8" });
  state.objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = state.objectUrl;
  link.download = state.result.fileName;
  link.click();
}

function clearAll() {
  cleanupUrl();
  state.files = [];
  state.result = null;
  elements.fileInput.value = "";
  elements.sourcePath.value = "";
  elements.convertButton.disabled = true;
  elements.downloadButton.disabled = true;
  elements.statusText.textContent = "等待选择目录";
  elements.preview.textContent = "选择 qx 抓包目录后，生成的 txt 预览会显示在这里。";
  setStats();
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

function cleanupUrl() {
  if (!state.objectUrl) return;
  URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = "";
}

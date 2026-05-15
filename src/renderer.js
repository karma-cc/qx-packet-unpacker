const state = {
  sourceDir: "",
  outputPath: "",
};

const elements = {
  pickButton: document.querySelector("#pickButton"),
  chooseButton: document.querySelector("#chooseButton"),
  convertButton: document.querySelector("#convertButton"),
  openButton: document.querySelector("#openButton"),
  dropZone: document.querySelector("#dropZone"),
  sourcePath: document.querySelector("#sourcePath"),
  statusText: document.querySelector("#statusText"),
  preview: document.querySelector("#preview"),
  requestCount: document.querySelector("#requestCount"),
  decodedCount: document.querySelector("#decodedCount"),
  jsonCount: document.querySelector("#jsonCount"),
  binaryCount: document.querySelector("#binaryCount"),
};

elements.pickButton.addEventListener("click", pickSource);
elements.chooseButton.addEventListener("click", pickSource);
elements.convertButton.addEventListener("click", convert);
elements.openButton.addEventListener("click", () => window.qxApp.openOutput(state.outputPath));

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
  const item = event.dataTransfer.files[0];
  if (!item?.path) return;
  setSource(item.path);
});

async function pickSource() {
  const dir = await window.qxApp.pickSource();
  if (dir) setSource(dir);
}

function setSource(dir) {
  state.sourceDir = dir;
  state.outputPath = "";
  elements.sourcePath.value = dir;
  elements.convertButton.disabled = false;
  elements.openButton.disabled = true;
  elements.statusText.textContent = "已选择目录";
  elements.preview.textContent = "准备解包。";
  setStats();
}

async function convert() {
  if (!state.sourceDir) return;

  setBusy(true);
  elements.statusText.textContent = "正在解包和写入 txt...";
  elements.preview.textContent = "处理中，请稍等。";

  try {
    const result = await window.qxApp.convert(state.sourceDir);
    if (!result) {
      elements.statusText.textContent = "已取消保存";
      return;
    }

    state.outputPath = result.outputPath;
    setStats(result.stats);
    elements.openButton.disabled = false;
    elements.statusText.textContent = `已生成：${result.outputPath}`;
    elements.preview.textContent = result.preview;
  } catch (error) {
    elements.statusText.textContent = "转换失败";
    elements.preview.textContent = error?.message || String(error);
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  elements.convertButton.disabled = isBusy || !state.sourceDir;
  elements.chooseButton.disabled = isBusy;
  elements.pickButton.disabled = isBusy;
}

function setStats(stats = {}) {
  elements.requestCount.textContent = stats.requests ?? 0;
  elements.decodedCount.textContent = stats.decodedResponses ?? 0;
  elements.jsonCount.textContent = stats.jsonBodies ?? 0;
  elements.binaryCount.textContent = stats.binaryBodies ?? 0;
}

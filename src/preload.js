const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qxApp", {
  pickSource: () => ipcRenderer.invoke("pick-source"),
  convert: (sourceDir) => ipcRenderer.invoke("convert", sourceDir),
  openOutput: (outputPath) => ipcRenderer.invoke("open-output", outputPath),
});

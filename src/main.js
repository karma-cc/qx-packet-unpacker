const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { convertCaptureDirectory } = require("./converter");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: "QX Packet Unpacker",
    backgroundColor: "#f6f4ef",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("pick-source", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 QX 抓包导出目录",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("convert", async (_event, sourceDir) => {
  const defaultName = `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}_qx_可读整理.txt`;
  const save = await dialog.showSaveDialog(mainWindow, {
    title: "保存整理后的 txt",
    defaultPath: path.join(sourceDir, defaultName),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });

  if (save.canceled || !save.filePath) return null;

  const result = await convertCaptureDirectory(sourceDir, {
    outputPath: save.filePath,
  });

  return {
    outputPath: result.outputPath,
    stats: result.stats,
    preview: result.report.slice(0, 12000),
  };
});

ipcMain.handle("open-output", async (_event, outputPath) => {
  if (!outputPath) return;
  await shell.openPath(outputPath);
});

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  selectFolder: () => ipcRenderer.invoke("dialog:openDirectory"),
  onUpdateFileList: (callback) =>
    ipcRenderer.on("update-file-list", (_event, fileTree) => callback(fileTree)),
  getFileServerPort: () => ipcRenderer.invoke("file:getServerPort"),
  getFileServerToken: () => ipcRenderer.invoke("file:getServerToken"),
  generateDownloadToken: (fileRef) => ipcRenderer.invoke("file:generateDownloadToken", fileRef),
  getHost: () => ipcRenderer.invoke("file:getHost"),
  getNatResult: () => ipcRenderer.invoke("file:getNatResult"),
  saveFile: (fileData, fileName) => ipcRenderer.invoke("file:save", { fileData, fileName }),
  stopSharing: () => ipcRenderer.invoke("folder:stopSharing"),
  getCurrentFolder: () => ipcRenderer.invoke("folder:getCurrent"),
  selectFile: () => ipcRenderer.invoke("dialog:selectFile"),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  readFileForRelay: (filePath, byteOffset, chunkSize) =>
    ipcRenderer.invoke("file:readForRelay", { filePath, byteOffset, chunkSize }),
  logTelemetry: (payload) => ipcRenderer.invoke("telemetry:log", payload),
  setAppBadgeCount: (count) => ipcRenderer.invoke("app:setBadgeCount", count),
  // JWT persistence via OS keychain / safeStorage
  storeToken: (token) => ipcRenderer.invoke("auth:storeToken", token),
  getStoredToken: () => ipcRenderer.invoke("auth:getToken"),
  clearStoredToken: () => ipcRenderer.invoke("auth:clearToken"),
});

/** Preload script -- bridges main process IPC to renderer via contextBridge. */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  /* Settings */
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke("save-settings", updates),

  /* Recording */
  startRecording: (engine: string, meetingType: string) =>
    ipcRenderer.invoke("start-recording", engine, meetingType),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  pauseRecording: () => ipcRenderer.invoke("pause-recording"),

  /* Session management */
  getSessionHistory: () => ipcRenderer.invoke("get-session-history"),
  deleteSession: (filePath: string) => ipcRenderer.invoke("delete-session", filePath),
  mergeNotes: () => ipcRenderer.invoke("merge-notes"),
  discardTranscript: () => ipcRenderer.invoke("discard-transcript"),

  /* File operations */
  browseDirectory: () => ipcRenderer.invoke("browse-directory"),
  openFile: (filePath: string) => ipcRenderer.invoke("open-file", filePath),

  /* Window controls */
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  closeWindow: () => ipcRenderer.invoke("close-window"),

  /* Server messages (main -> renderer) */
  onServerMessage: (cb: (msg: unknown) => void) => {
    ipcRenderer.on("server-message", (_e, msg) => cb(msg));
  },

  /* Float window actions (float renderer -> main) */
  floatStop: () => ipcRenderer.send("float-stop"),
  floatNavigate: () => ipcRenderer.send("float-navigate"),
});

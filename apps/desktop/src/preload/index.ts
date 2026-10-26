/** Hands the renderer a MessagePort to the daemon, and nothing else. */
import { ipcRenderer } from "electron";

ipcRenderer.on("ekatva:port", (event) => {
  window.postMessage("ekatva:port", "*", event.ports);
});

window.addEventListener("message", (e) => {
  if (e.data === "ekatva:connect" && e.source === window) ipcRenderer.send("ekatva:connect");
});

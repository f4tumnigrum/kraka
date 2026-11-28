import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "@kraka/protocol";

if (!process.sandboxed) throw Error("A sandboxed isolated renderer is required");
const methods = Object.fromEntries(
  Object.keys(DESKTOP_IPC).map((name) => [
    name,
    (input) => ipcRenderer.invoke("kraka:" + name, input),
  ]),
);
contextBridge.exposeInMainWorld("desktop", methods);
ipcRenderer.on("kraka:installed", (_event, record) => {
  const output = document.querySelector("output");
  if (!output) return;
  output.textContent = record.rows
    .flatMap((r) => (r.objectType === "message" ? [r.value.text] : []))
    .join("\n");
  output.dataset.installed = JSON.stringify(record);
  output.dispatchEvent(new Event("installed"));
});

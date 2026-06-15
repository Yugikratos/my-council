import { app, BrowserWindow } from "electron";
import net from "node:net";

// Check if the port is already bound
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(true); // Port is already in use
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false); // Port is free
    });
    server.listen(port);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 700,
    height: 650,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL("http://localhost:3000");
}

app.whenReady().then(async () => {
  const port = Number(process.env.PORT) || 3000;
  const inUse = await isPortInUse(port);

  if (!inUse) {
    console.log(`[Electron] Port ${port} is free. Starting local Express server...`);
    await import("./server/index.js");
    // Wait briefly for the server to finish binding
    await new Promise((resolve) => setTimeout(resolve, 500));
  } else {
    console.log(`[Electron] Port ${port} is already in use. Hooking to running server...`);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

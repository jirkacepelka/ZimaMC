// ZimaMC for Windows: the same web interface in its own window, with servers
// running as plain Java processes (no Docker). Closing the window keeps ZimaMC
// in the tray; "Quit" saves and stops the servers.
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import fs from "node:fs";
import path from "node:path";

// Settings for the backend must be in place before it is loaded. The data folder is the
// one earlier versions used (%APPDATA%\ZimaMC); the window's own browser data goes in a subfolder.
process.env.ZIMAMC_RUNTIME ??= "native";
process.env.DATA_DIR ??= path.join(app.getPath("appData"), "ZimaMC");
process.env.HOST ??= "127.0.0.1";
app.setPath("userData", path.join(process.env.DATA_DIR, "app"));

type Zima = Awaited<ReturnType<typeof import("../../backend/src/server.js").startZimaMC>>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backend = require("./backend.cjs") as typeof import("../../backend/src/server.js");

const TEXT = {
  en: {
    open: "Open ZimaMC",
    autostart: "Start with Windows",
    updates: "Check for updates",
    quit: "Quit ZimaMC",
    stopping: "Saving and stopping servers…",
    trayTitle: "ZimaMC keeps running",
    trayBody: "Your servers stay online. Open ZimaMC or quit it from the icon next to the clock.",
    startFailed: "ZimaMC could not start",
    updateReady: (v: string) => `ZimaMC ${v} is ready to install.`,
    updateDetail: "Restarting saves and stops your servers for a moment. Otherwise the update is installed the next time ZimaMC quits.",
    restartNow: "Restart now",
    later: "Later",
    upToDate: "You have the newest version of ZimaMC.",
    updateFailed: "Could not check for updates. Try again later.",
    forgot: "Forgot password…",
    forgotQuestion: "Remove the password of ZimaMC?",
    forgotDetail: "You will choose a new one right away. Servers, worlds and settings stay as they are.",
    remove: "Remove password",
    cancel: "Cancel",
  },
  cs: {
    open: "Otevřít ZimaMC",
    autostart: "Spouštět s Windows",
    updates: "Zkontrolovat aktualizace",
    quit: "Ukončit ZimaMC",
    stopping: "Ukládám a vypínám servery…",
    trayTitle: "ZimaMC běží dál",
    trayBody: "Servery zůstávají online. ZimaMC otevřeš nebo ukončíš přes ikonu vedle hodin.",
    startFailed: "ZimaMC se nepodařilo spustit",
    updateReady: (v: string) => `ZimaMC ${v} je připravená k instalaci.`,
    updateDetail: "Restart na chvíli uloží a vypne servery. Jinak se aktualizace nainstaluje při příštím ukončení ZimaMC.",
    restartNow: "Restartovat teď",
    later: "Později",
    upToDate: "Máš nejnovější verzi ZimaMC.",
    updateFailed: "Aktualizace se nepodařilo zkontrolovat. Zkus to později.",
    forgot: "Zapomenuté heslo…",
    forgotQuestion: "Odstranit heslo ZimaMC?",
    forgotDetail: "Hned si nastavíš nové. Servery, světy i nastavení zůstanou, jak jsou.",
    remove: "Odstranit heslo",
    cancel: "Zrušit",
  },
};

const hidden = process.argv.includes("--hidden");
const smokeFile = process.env.ZIMAMC_SMOKE;
let zima: Zima | undefined;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
/** The window talks to the backend over IPv4 loopback; "localhost" may resolve to ::1 first. */
const appUrl = () => `http://127.0.0.1:${zima!.port}`;

const asset = (name: string) => path.join(__dirname, name);
const stateFile = () => path.join(app.getPath("userData"), "desktop.json");

function readState(): { trayHintShown?: boolean; autostartSet?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeState(patch: Record<string, unknown>) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }));
  } catch {
    /* not important */
  }
}

function text() {
  const lang = zima?.store.settings.language || app.getLocale();
  return lang.toLowerCase().startsWith("cs") ? TEXT.cs : TEXT.en;
}

function show() {
  if (!win || win.isDestroyed()) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
}

function createWindow() {
  const origin = appUrl();
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    title: "ZimaMC",
    icon: asset("icon.png"),
    backgroundColor: "#121212",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  // Links to other sites open in the normal browser; ZimaMC's own pages (downloads) stay here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin)) return { action: "allow" };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(origin)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  win.once("ready-to-show", () => {
    if (!hidden) win?.show();
  });
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (!readState().trayHintShown && Notification.isSupported()) {
      new Notification({ title: text().trayTitle, body: text().trayBody, icon: asset("icon.png") }).show();
      writeState({ trayHintShown: true });
    }
  });
  // Windows is shutting down or logging off: save the worlds while there is time.
  win.on("session-end", () => void zima?.stop());
  void win.loadURL(appUrl());
}

function loginItem() {
  return app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
}

/** Tray icon and menu; the menu is rebuilt now and then to follow the language chosen in ZimaMC. */
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(asset("tray.png")));
    tray.on("click", show);
    tray.on("double-click", show);
  }
  if (!quitting) tray.setToolTip("ZimaMC");
  const t = text();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t.open, click: show },
      { type: "separator" },
      {
        label: t.autostart,
        type: "checkbox",
        checked: loginItem(),
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }),
      },
      { label: t.updates, enabled: app.isPackaged, click: () => void checkUpdates(true) },
      { label: t.forgot, click: () => void forgotPassword() },
      { type: "separator" },
      { label: t.quit, click: () => void quit() },
    ]),
  );
}

/** Whoever sits at this PC owns its servers anyway, so the tray may reset the password. */
async function forgotPassword() {
  const t = text();
  const r = await dialog.showMessageBox({ type: "question", buttons: [t.remove, t.cancel], defaultId: 0, cancelId: 1, message: t.forgotQuestion, detail: t.forgotDetail });
  if (r.response !== 0 || !zima) return;
  zima.auth.reset();
  show();
  win?.webContents.reload();
}

async function stopEverything() {
  quitting = true;
  tray?.setToolTip(text().stopping);
  const running = zima ? [...zima.servers.live.values()].some((l) => ["online", "starting", "stopping"].includes(l.status)) : false;
  if (running && Notification.isSupported()) new Notification({ title: "ZimaMC", body: text().stopping }).show();
  win?.hide();
  await zima?.stop().catch((e) => console.error(e));
}

async function quit() {
  if (quitting) return;
  await stopEverything();
  app.quit();
}

// ---- Updates from GitHub Releases ----

let manualCheck = false;
async function checkUpdates(manual = false) {
  if (!app.isPackaged) return;
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    if (manual) void dialog.showMessageBox({ type: "warning", message: text().updateFailed });
  }
}

function setUpUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-not-available", () => {
    if (manualCheck) void dialog.showMessageBox({ type: "info", message: text().upToDate });
    manualCheck = false;
  });
  autoUpdater.on("error", (e) => console.error("[update]", e?.message ?? e));
  autoUpdater.on("update-downloaded", async (info) => {
    const t = text();
    const r = await dialog.showMessageBox({
      type: "info",
      buttons: [t.restartNow, t.later],
      defaultId: 0,
      cancelId: 1,
      message: t.updateReady(info.version),
      detail: t.updateDetail,
    });
    if (r.response !== 0) return;
    await stopEverything();
    autoUpdater.quitAndInstall(true, true);
  });
  setTimeout(() => void checkUpdates(), 15_000);
  setInterval(() => void checkUpdates(), 6 * 3600_000);
}

// ---- Start ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => zima && show());
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    void quit();
  });
  app.on("window-all-closed", () => {
    /* keep running in the tray */
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("io.github.jirkacepelka.zimamc");
    try {
      zima = await backend.startZimaMC({ staticDir: asset("ui"), anyPort: true });
    } catch (e) {
      dialog.showErrorBox(TEXT.en.startFailed, e instanceof Error ? e.message : String(e));
      quitting = true;
      app.exit(1);
      return;
    }
    // First run: start with Windows, so auto-start servers come back after a reboot.
    if (app.isPackaged && !readState().autostartSet) {
      app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
      writeState({ autostartSet: true });
    }
    buildTray();
    setInterval(buildTray, 30_000);
    createWindow();
    setUpUpdates();

    if (smokeFile) {
      win!.webContents.once("did-finish-load", async () => {
        const title = await win!.webContents.executeJavaScript("document.title");
        const status = await fetch(`${appUrl()}/api/status`).then((r) => r.json());
        fs.writeFileSync(smokeFile, JSON.stringify({ ok: true, url: appUrl(), title, status }));
        await quit();
      });
    }
  });
}

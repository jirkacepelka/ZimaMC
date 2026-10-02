# ZimaMC

**Your own Minecraft server in a few clicks, for ZimaOS and Windows.**

ZimaMC is a web app for [ZimaOS](https://www.zimaspace.com/) (and CasaOS), and a single `.exe` for Windows, that lets anyone create and run Minecraft Java servers without touching a terminal. The simple path is three steps: name, game, size. Everything else is behind **Expert mode**.

![Dashboard](docs/screenshot-dashboard.png)

## Features

- **One-click servers**: Paper and Folia (plugins), Vanilla, Fabric and Forge (mods). Several servers at once.
- **Performance limits**: every server gets its own memory and CPU limit, and you set a global limit that no single server can exceed, so Minecraft never takes over the whole machine. The limits of running servers may add up to more than the global limit, since servers rarely use everything at once.
- **Any disk**: choose where each server lives (other drives on ZimaOS, other drive letters on Windows, or any folder), move a server later, and keep backups on a different disk.
- **World pre-generation with [Chunky](https://modrinth.com/plugin/chunky)**: the wizard offers it for plugin and mod servers and estimates disk space and time from a quick, silent benchmark of your machine. Progress, pause and cancel are on the server's overview, and the console cheat sheet lists Chunky's commands.
- **Plugins and mods from [Modrinth](https://modrinth.com)**: search, install with dependencies, update and remove. Only versions compatible with your server are shown.
- **Let friends join**, in three levels:
  1. Your public address, with automatic router port opening (UPnP / NAT-PMP) and a connection test.
  2. **Your own domain via Cloudflare**: a prefilled token link, then ZimaMC creates the A and SRV records and keeps them updated when your home IP changes (dynamic DNS).
  3. **A playit.gg tunnel** for connections behind CGNAT, where ports can't be opened. You approve the machine once and ZimaMC creates the tunnel.
- **Console** with live log, commands and a cheat sheet of everyday commands, plus the ones your plugins and mods add.
- **Plugin and mod settings**: one click opens their config files in the built-in editor.
- **Players**: whitelist, operators, bans and kicks.
- **Backups**: manual or scheduled, with retention, restore and download.
- **File manager**: browse, edit, upload and download.
- **Multilingual** (English and Czech so far). Adding a language means adding one JSON file, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Install on Windows

1. Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Download `ZimaMC.exe` from the [latest release](https://github.com/jirkacepelka/ZimaMC/releases/latest) and start it. Windows may warn about an unknown app (the file is not code-signed yet): choose **More info → Run anyway**.
3. The web page opens at `http://localhost:8765`. Choose a password and create your first server.

Keep the window open while you use ZimaMC; closing it only stops the web page, your Minecraft servers keep running in Docker. Your PC must stay on and awake for friends to join, which makes this a good way to try ZimaMC but not ideal for a permanent server. Data lives in `%APPDATA%\ZimaMC`. The page is only reachable from the same PC unless you set `HOST=0.0.0.0`. Forgot the password? Start `ZimaMC.exe --reset-password` from a terminal.

## Install on ZimaOS

1. Open the **App Store** in ZimaOS and click **+** → **Install a customized app**.
2. Choose **Import**, paste the contents of [`docker-compose.yml`](docker-compose.yml) and install.
3. Open ZimaMC from the dashboard (port **8765**), choose a password and a performance limit, and create your first server.

Already installed an older version? Import the new `docker-compose.yml` once more (your data stays): it now also mounts `/DATA` and `/media`, so you can put servers on other drives.

The app needs access to `/var/run/docker.sock` so it can start the Minecraft servers as separate containers ([`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server)). All data lives in `/DATA/AppData/zimamc`.

**Forgot the password?** In the app's settings in ZimaOS, add the environment variable `RESET_PASSWORD=true` and restart the app. Then remove the variable again.

## How it works

```
ZimaOS (Docker)
 ├─ zimamc              web UI + API (host network, port 8765)
 │    └─ /var/run/docker.sock, /DATA/AppData/zimamc
 ├─ zimamc-srv-<id>     one container per Minecraft server, with --memory / --cpus limits
 └─ zimamc-playit       optional playit.gg agent
```

- `backend/`: Node.js + TypeScript (Fastify, dockerode). The state is stored in `zimamc.json` in the data folder.
- `frontend/`: React + Vite. Translations are in `frontend/src/locales/*.json`.

## Development

```bash
npm install
npm run dev          # backend on :8765, frontend on :5173 (proxies /api)
npm test             # backend tests
npm run typecheck
npm run build        # production build
npm run build:app    # single-file app (ZimaMC.exe on Windows) in dist-app/
```

Docker must be running locally. By default data goes to `./data`; set `DATA_DIR` to change it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8765` | Web UI port |
| `DATA_DIR` | `./data` | Where servers, backups and settings are stored |
| `HOST_DATA_DIR` | `DATA_DIR` | The same folder as the Docker host sees it (only needed if the paths differ) |
| `MC_IMAGE` | `itzg/minecraft-server` | Image used for servers |
| `HOST` | `0.0.0.0` (`127.0.0.1` on Windows) | Address the web UI listens on |
| `STORAGE_ROOTS` | – | Extra folders (comma-separated) to offer as disks |
| `RESET_PASSWORD` | – | `true` removes the password on start (or start with `--reset-password`) |

## License

MIT. Minecraft is a trademark of Mojang Synergies AB. ZimaMC is not affiliated with Mojang or Microsoft.

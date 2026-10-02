## ZimaMC 0.11

**ZimaMC for Windows is now a regular app.** Download **`ZimaMC-Setup-0.11.0.exe`** below and run it. Docker and the terminal are no longer needed: ZimaMC downloads Java and the server software itself and runs your servers as normal programs. Windows may show a "protected your PC" message because the installer is not code-signed yet: choose **More info → Run anyway**.

**New on Windows**
- ZimaMC opens in its own window, with a Start menu and desktop shortcut.
- Closing the window keeps ZimaMC running in the tray next to the clock, so servers stay online. **Quit** in the tray menu saves and stops them.
- Starts with Windows (you can turn it off in the tray menu), so servers set to start automatically come back after a reboot.
- Updates itself: new versions download in the background and install with one click.
- Forgot the password? The tray menu can remove it.
- When Windows Firewall asks about Java the first time a server starts, allow it so players on other devices can join.

Coming from 0.9 or 0.10 with Docker Desktop: your servers are in the same place (`%APPDATA%\ZimaMC`) and the new app picks them up. Stop them in the old version first, then you can close Docker Desktop for good.

**Also new**
- You stay logged in after ZimaMC or the PC restarts (also on ZimaOS).
- Chunky continues pre-generating the world after a server restart, unless you paused it.

On ZimaOS nothing changes: servers keep running in Docker as before. Update by importing the new `docker-compose.yml` (your data stays).

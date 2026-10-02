## ZimaMC 0.10.1

**Fixed**
- Chunky now continues pre-generating the world after a server restart. If you paused or cancelled it, it stays paused until you continue it.

## ZimaMC 0.10

**Download `ZimaMC.exe` below** to run ZimaMC on Windows. It needs [Docker Desktop](https://www.docker.com/products/docker-desktop/). Windows may show a "protected your PC" message because the app is not code-signed yet: choose **More info → Run anyway**. On ZimaOS, update the app by importing the new `docker-compose.yml` (your data stays).

**New**
- **Choose a disk for each server.** Pick it in the wizard, browse to any folder, and move a server to another disk later. Backups can live on a different disk. On ZimaOS, other drives (`/media`) and `/DATA` show up after re-importing the compose file, and paths copied from the ZimaOS Files app work.
- **World pre-generation with Chunky.** Plugin and mod servers are offered Chunky as the last step of the wizard, with a suggested radius and estimates of disk space and time from a quick test of your machine. Progress, pause and cancel are on the server's overview, and the console cheat sheet lists Chunky's commands.
- **You choose backups.** Turn automatic backups on or off when creating a server. Incremental backups are the default: unchanged files are shared between backups, so a big world takes its space once. Full `.tar.gz` backups are still one click away.
- Plugin and mod settings open straight in the file editor, and the console has a command cheat sheet.

**Changed**
- You set the maximum number of players yourself.
- The performance limit is a budget: running servers may add up to more than it, but no single server can be bigger.

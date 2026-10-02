import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";

export interface ProcSample {
  /** CPU time used so far, in milliseconds. */
  cpuMs: number;
  memoryBytes: number;
}

/**
 * CPU time and memory of processes, and CPU caps. Linux reads /proc; Windows
 * keeps one hidden PowerShell running and asks it, which is much cheaper than
 * starting a program every few seconds.
 */
export class ProcStats {
  private ps?: ChildProcessWithoutNullStreams;
  private psBuf = "";
  private pending: { resolve: (lines: string[]) => void; lines: string[] }[] = [];

  async sample(pids: number[]): Promise<Map<number, ProcSample>> {
    const out = new Map<number, ProcSample>();
    if (!pids.length) return out;
    if (process.platform === "win32") {
      const lines = await this.ask(`S ${pids.join(",")}`).catch(() => [] as string[]);
      for (const l of lines) {
        const [pid, cpu, mem] = l.trim().split(/\s+/).map(Number);
        if (Number.isFinite(pid)) out.set(pid, { cpuMs: cpu, memoryBytes: mem });
      }
      return out;
    }
    if (process.platform === "linux") {
      const tick = 100; // USER_HZ on practically every Linux
      for (const pid of pids) {
        try {
          const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
          const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const cpuMs = ((Number(f[11]) + Number(f[12])) / tick) * 1000;
          const status = await fsp.readFile(`/proc/${pid}/status`, "utf8");
          const rss = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024;
          out.set(pid, { cpuMs, memoryBytes: rss });
        } catch {
          /* gone */
        }
      }
    }
    return out;
  }

  /** Limit a process to `cpus` logical processors (rounded up) and lower its priority, so the PC stays responsive. */
  async limit(pid: number, cpus: number) {
    const n = Math.max(1, Math.min(os.availableParallelism(), Math.ceil(cpus)));
    const total = os.availableParallelism();
    // The last cores, leaving the first ones (where Windows and the UI tend to run) a bit freer.
    let mask = 0n;
    for (let i = total - n; i < total; i++) mask |= 1n << BigInt(i);
    if (process.platform === "win32") await this.ask(`A ${pid} ${mask.toString()}`).catch(() => {});
    else if (process.platform === "linux") {
      await new Promise<void>((resolve) => {
        const c = spawn("taskset", ["-a", "-p", mask.toString(16), String(pid)], { stdio: "ignore" });
        c.on("error", () => resolve());
        c.on("exit", () => resolve());
      });
    }
  }

  private ask(cmd: string): Promise<string[]> {
    const ps = this.helper();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A stuck helper would answer the wrong questions later; start a fresh one next time.
        this.close();
        reject(new Error("timeout"));
      }, 10_000);
      this.pending.push({ resolve: (l) => (clearTimeout(timer), resolve(l)), lines: [] });
      ps.stdin.write(`${cmd}\n`);
    });
  }

  private helper() {
    if (this.ps && this.ps.exitCode === null) return this.ps;
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ')
  if ($parts[0] -eq 'S') {
    foreach ($id in $parts[1].Split(',')) {
      $p = Get-Process -Id ([int]$id)
      if ($p) { [Console]::Out.WriteLine("$($p.Id) $([long]$p.TotalProcessorTime.TotalMilliseconds) $($p.WorkingSet64)") }
    }
  } elseif ($parts[0] -eq 'A') {
    $p = Get-Process -Id ([int]$parts[1])
    if ($p) { $p.ProcessorAffinity = [IntPtr][long]$parts[2]; $p.PriorityClass = 'BelowNormal' }
  }
  [Console]::Out.WriteLine('END')
  [Console]::Out.Flush()
}`;
    const ps = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    ps.stdout.on("data", (d: Buffer) => {
      this.psBuf += d.toString("utf8");
      const lines = this.psBuf.split(/\r?\n/);
      this.psBuf = lines.pop() ?? "";
      for (const l of lines) {
        const cur = this.pending[0];
        if (!cur) continue;
        if (l === "END") {
          this.pending.shift();
          cur.resolve(cur.lines);
        } else if (l.trim()) cur.lines.push(l);
      }
    });
    ps.on("exit", () => {
      for (const p of this.pending.splice(0)) p.resolve([]);
    });
    ps.on("error", () => {});
    this.ps = ps;
    return ps;
  }

  close() {
    this.ps?.kill();
    this.ps = undefined;
    this.psBuf = "";
    for (const p of this.pending.splice(0)) p.resolve([]);
  }
}

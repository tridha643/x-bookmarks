import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const LAUNCH_AGENT_LABEL = "com.xbookmarks.sync";
export const PLIST_PATH = resolve(homedir(), `Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`);
const PROJECT_ROOT = resolve(import.meta.dir, "..");
const LOG_PATH = resolve(PROJECT_ROOT, "data/cron.log");

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getUid(): string {
  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    throw new Error("macOS launchd cron is only supported on POSIX/macOS.");
  }
  return String(uid);
}

async function runLaunchctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export function parseIntervalSeconds(raw?: string): number {
  if (!raw) return 3600; // default 1 hour
  const m = raw.trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!m) {
    throw new Error(`Invalid interval '${raw}'. Use e.g. 30m, 1h, 6h, or 3600.`);
  }
  const n = Number(m[1]);
  const unit = (m[2] || "m").toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  const secs = n * mult;
  if (secs < 60) throw new Error("Interval must be at least 60 seconds.");
  return secs;
}

export function buildPlist(opts: { intervalSeconds: number; runAtLoad: boolean; threads: boolean }): string {
  const bunBin = Bun.which("bun") || process.execPath;
  const cliPath = resolve(PROJECT_ROOT, "src/cli.ts");
  const programArgs = [bunBin, "run", cliPath, "sync", "--engine", "browser", "--retry-errors"];
  if (opts.threads) programArgs.push("--threads");

  const argsXml = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(PROJECT_ROOT)}</string>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <${opts.runAtLoad ? "true" : "false"}/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LOG_PATH)}</string>
</dict>
</plist>
`;
}

export async function installCron(opts: {
  every?: string;
  runAtLoad?: boolean;
  threads?: boolean;
} = {}): Promise<void> {
  const intervalSeconds = parseIntervalSeconds(opts.every);
  const uid = getUid();

  mkdirSync(resolve(PLIST_PATH, ".."), { recursive: true });
  mkdirSync(resolve(LOG_PATH, ".."), { recursive: true });

  // Unload prior agent if present
  await runLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);

  const plist = buildPlist({
    intervalSeconds,
    runAtLoad: Boolean(opts.runAtLoad),
    threads: Boolean(opts.threads),
  });
  writeFileSync(PLIST_PATH, plist, "utf8");

  const boot = await runLaunchctl(["bootstrap", `gui/${uid}`, PLIST_PATH]);
  if (boot.code !== 0) {
    throw new Error(`launchctl bootstrap failed: ${boot.stderr || boot.stdout}`);
  }

  const mins = Math.round(intervalSeconds / 60);
  console.log(`Installed and loaded macOS LaunchAgent (${LAUNCH_AGENT_LABEL}).`);
  console.log(`  Schedule: every ${mins >= 60 && mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`} (${intervalSeconds}s)`);
  console.log(`  Plist:    ${PLIST_PATH}`);
  console.log(`  Log:      ${LOG_PATH}`);
}

export async function uninstallCron(): Promise<void> {
  const uid = getUid();
  await runLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`Unloaded and removed ${PLIST_PATH}.`);
  } else {
    console.log("LaunchAgent was not installed.");
  }
}

export async function runCronNow(): Promise<void> {
  const uid = getUid();
  const res = await runLaunchctl(["kickstart", "-k", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  if (res.code !== 0) {
    throw new Error(
      `Could not trigger ${LAUNCH_AGENT_LABEL}. Is it installed? Run 'bun run cron install' first. (${res.stderr || res.stdout})`
    );
  }
  console.log(`Triggered immediate run of ${LAUNCH_AGENT_LABEL}. Tail logs with: tail -f ${LOG_PATH}`);
}

export async function cronStatus(): Promise<void> {
  const uid = getUid();
  const installed = existsSync(PLIST_PATH);
  console.log(`LaunchAgent: ${LAUNCH_AGENT_LABEL}`);
  console.log(`Plist file:  ${installed ? PLIST_PATH : "(not installed)"}`);

  const info = await runLaunchctl(["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  if (info.code === 0) {
    const state = info.stdout.match(/state = (.+)/)?.[1] ?? "loaded";
    const lastExit = info.stdout.match(/last exit code = (.+)/)?.[1] ?? "n/a";
    const runs = info.stdout.match(/runs = (.+)/)?.[1] ?? "0";
    console.log(`Status:      loaded (state=${state}, runs=${runs}, lastExit=${lastExit})`);
  } else {
    console.log("Status:      not loaded");
  }

  if (existsSync(LOG_PATH)) {
    const lines = readFileSync(LOG_PATH, "utf8").trim().split(/\r?\n/);
    const tail = lines.slice(-15);
    console.log(`\nLast ${tail.length} lines of ${LOG_PATH}:`);
    for (const l of tail) console.log(`  ${l}`);
  }
}

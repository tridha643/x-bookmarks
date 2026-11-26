import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const LAUNCH_AGENT_LABEL = "com.xbookmarks.sync";

const UNIT_SECONDS = new Map<string, number>([
  ["s", 1],
  ["m", 60],
  ["h", 3600],
  ["d", 86_400],
]);

const xmlEscape = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export const parseIntervalSeconds = (raw: string | undefined): number => {
  if (raw === undefined) return 86_400;
  const m = /^(\d+)(s|m|h|d)?$/i.exec(raw.trim());
  const mult = UNIT_SECONDS.get((m?.[2] ?? "m").toLowerCase());
  if (m?.[1] === undefined || mult === undefined) {
    throw new Error(`Invalid interval '${raw}'. Use e.g. 30m, 1h, 24h.`);
  }
  const secs = Number(m[1]) * mult;
  if (secs < 60) throw new Error("Interval must be at least 60 seconds.");
  return secs;
};

export const buildPlist = (opts: {
  readonly nodeBin: string;
  readonly projectRoot: string;
  readonly intervalSeconds: number;
  readonly runAtLoad: boolean;
  readonly threads: boolean;
}): string => {
  const entryPath = resolve(opts.projectRoot, "src/main.ts");
  const logPath = resolve(opts.projectRoot, "data/cron.log");
  const args = [opts.nodeBin, entryPath, "sync", ...(opts.threads ? ["--threads"] : [])];
  const argsXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const pathEnv = `${dirname(opts.nodeBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

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
  <string>${xmlEscape(opts.projectRoot)}</string>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <${opts.runAtLoad ? "true" : "false"}/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
};

export interface LaunchctlResult {
  readonly ok: boolean;
  readonly output: string;
}

export interface CronRuntime {
  readonly homeDir?: string;
  readonly uid?: number | null;
  readonly nodeBin?: string;
  readonly execLaunchctl?: (args: ReadonlyArray<string>) => LaunchctlResult;
}

const defaultRunLaunchctl = (args: ReadonlyArray<string>): LaunchctlResult => {
  try {
    const stdout = execFileSync("launchctl", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
};

const resolveUid = (rt?: CronRuntime): number | undefined =>
  rt?.uid === undefined ? process.getuid?.() : (rt.uid ?? undefined);

const plistPath = (homeDir?: string): string =>
  resolve(homeDir ?? homedir(), `Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`);

export const installCron = (opts: {
  readonly projectRoot: string;
  readonly every?: string;
  readonly runAtLoad?: boolean;
  readonly threads?: boolean;
  readonly runtime?: CronRuntime;
}): string => {
  const uid = resolveUid(opts.runtime);
  if (uid === undefined) throw new Error("macOS launchd cron requires POSIX uid.");
  const execLaunchctl = opts.runtime?.execLaunchctl ?? defaultRunLaunchctl;
  const intervalSeconds = parseIntervalSeconds(opts.every);
  const target = plistPath(opts.runtime?.homeDir);
  const logPath = resolve(opts.projectRoot, "data/cron.log");
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });

  execLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  const plist = buildPlist({
    nodeBin: opts.runtime?.nodeBin ?? process.execPath,
    projectRoot: opts.projectRoot,
    intervalSeconds,
    runAtLoad: opts.runAtLoad ?? false,
    threads: opts.threads ?? true,
  });
  writeFileSync(target, plist, "utf8");
  const res = execLaunchctl(["bootstrap", `gui/${uid}`, target]);
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.output}`);
  return `Installed ${LAUNCH_AGENT_LABEL} (every ${intervalSeconds}s) -> ${target}`;
};

export const uninstallCron = (runtime?: CronRuntime): string => {
  const uid = resolveUid(runtime);
  if (uid === undefined) throw new Error("macOS launchd cron requires POSIX uid.");
  const execLaunchctl = runtime?.execLaunchctl ?? defaultRunLaunchctl;
  execLaunchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  const target = plistPath(runtime?.homeDir);
  if (existsSync(target)) {
    unlinkSync(target);
    return `Unloaded and removed ${target}`;
  }
  return "LaunchAgent was not installed.";
};

export const cronStatus = (projectRoot: string, runtime?: CronRuntime): string => {
  const uid = resolveUid(runtime);
  const execLaunchctl = runtime?.execLaunchctl ?? defaultRunLaunchctl;
  const target = plistPath(runtime?.homeDir);
  const lines = [`LaunchAgent: ${LAUNCH_AGENT_LABEL}`, `Plist: ${existsSync(target) ? target : "(not installed)"}`];
  if (uid !== undefined) {
    const info = execLaunchctl(["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
    lines.push(info.ok ? "Status: loaded" : "Status: not loaded");
  }
  const logPath = resolve(projectRoot, "data/cron.log");
  if (existsSync(logPath)) {
    const tail = readFileSync(logPath, "utf8").trim().split(/\r?\n/).slice(-10);
    lines.push(`Log (${logPath}):`, ...tail.map((l) => `  ${l}`));
  }
  return lines.join("\n");
};

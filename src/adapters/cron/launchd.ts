import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const SYNC_AGENT_LABEL = "com.xbookmarks.sync";
const SERVER_AGENT_LABEL = "com.xbookmarks.server";

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

const renderEnvDict = (entries: ReadonlyArray<readonly [string, string]>): string =>
  entries.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join("\n");

const renderArgsXml = (args: ReadonlyArray<string>): string =>
  args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

const buildPathEnv = (nodeBin: string): string => `${dirname(nodeBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

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

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SYNC_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${renderArgsXml(args)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.projectRoot)}</string>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <${opts.runAtLoad ? "true" : "false"}/>
  <key>EnvironmentVariables</key>
  <dict>
${renderEnvDict([["PATH", buildPathEnv(opts.nodeBin)]])}
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
};

export const buildServerPlist = (opts: {
  readonly nodeBin: string;
  readonly projectRoot: string;
  readonly host: string;
  readonly port: number;
  readonly authToken?: string | null;
}): string => {
  const entryPath = resolve(opts.projectRoot, "src/main.ts");
  const logPath = resolve(opts.projectRoot, "data/server.log");
  const envEntries: Array<readonly [string, string]> = [
    ["PATH", buildPathEnv(opts.nodeBin)],
    ["XBM_HTTP_HOST", opts.host],
    ["XBM_HTTP_PORT", String(opts.port)],
  ];
  if (opts.authToken !== undefined && opts.authToken !== null && opts.authToken !== "") {
    envEntries.push(["XBM_AUTH_TOKEN", opts.authToken]);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVER_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${renderArgsXml([opts.nodeBin, entryPath, "serve"])}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
${renderEnvDict(envEntries)}
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
  if (process.env.VITEST === "true") return { ok: false, output: "" };
  try {
    const stdout = execFileSync("launchctl", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
};

const resolveUid = (rt?: CronRuntime): number | undefined =>
  rt?.uid === undefined ? process.getuid?.() : (rt.uid ?? undefined);

const plistPath = (label: string, homeDir?: string): string =>
  resolve(homeDir ?? homedir(), `Library/LaunchAgents/${label}.plist`);

const installAgent = (label: string, plist: string, logPath: string, runtime?: CronRuntime): string => {
  const uid = resolveUid(runtime);
  if (uid === undefined) throw new Error("macOS launchd cron requires POSIX uid.");
  const execLaunchctl = runtime?.execLaunchctl ?? defaultRunLaunchctl;
  const target = plistPath(label, runtime?.homeDir);
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  execLaunchctl(["bootout", `gui/${uid}/${label}`]);
  writeFileSync(target, plist, "utf8");
  const res = execLaunchctl(["bootstrap", `gui/${uid}`, target]);
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.output}`);
  return target;
};

const uninstallAgent = (label: string, runtime?: CronRuntime): string => {
  const uid = resolveUid(runtime);
  if (uid === undefined) throw new Error("macOS launchd cron requires POSIX uid.");
  const execLaunchctl = runtime?.execLaunchctl ?? defaultRunLaunchctl;
  execLaunchctl(["bootout", `gui/${uid}/${label}`]);
  const target = plistPath(label, runtime?.homeDir);
  if (existsSync(target)) {
    unlinkSync(target);
    return `Unloaded and removed ${target}`;
  }
  return "LaunchAgent was not installed.";
};

const agentStatus = (label: string, logPath: string, runtime?: CronRuntime): string => {
  const uid = resolveUid(runtime);
  const execLaunchctl = runtime?.execLaunchctl ?? defaultRunLaunchctl;
  const target = plistPath(label, runtime?.homeDir);
  const lines = [`LaunchAgent: ${label}`, `Plist: ${existsSync(target) ? target : "(not installed)"}`];
  if (uid !== undefined) {
    const info = execLaunchctl(["print", `gui/${uid}/${label}`]);
    lines.push(info.ok ? "Status: loaded" : "Status: not loaded");
  }
  if (existsSync(logPath)) {
    const tail = readFileSync(logPath, "utf8").trim().split(/\r?\n/).slice(-10);
    lines.push(`Log (${logPath}):`, ...tail.map((l) => `  ${l}`));
  }
  return lines.join("\n");
};

export const installCron = (opts: {
  readonly projectRoot: string;
  readonly every?: string;
  readonly runAtLoad?: boolean;
  readonly threads?: boolean;
  readonly runtime?: CronRuntime;
}): string => {
  const intervalSeconds = parseIntervalSeconds(opts.every);
  const plist = buildPlist({
    nodeBin: opts.runtime?.nodeBin ?? process.execPath,
    projectRoot: opts.projectRoot,
    intervalSeconds,
    runAtLoad: opts.runAtLoad ?? false,
    threads: opts.threads ?? true,
  });
  const target = installAgent(SYNC_AGENT_LABEL, plist, resolve(opts.projectRoot, "data/cron.log"), opts.runtime);
  return `Installed ${SYNC_AGENT_LABEL} (every ${intervalSeconds}s) -> ${target}`;
};

export const uninstallCron = (runtime?: CronRuntime): string => uninstallAgent(SYNC_AGENT_LABEL, runtime);

export const cronStatus = (projectRoot: string, runtime?: CronRuntime): string =>
  agentStatus(SYNC_AGENT_LABEL, resolve(projectRoot, "data/cron.log"), runtime);

export const installServer = (opts: {
  readonly projectRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string | null;
  readonly runtime?: CronRuntime;
}): string => {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  const plist = buildServerPlist({
    nodeBin: opts.runtime?.nodeBin ?? process.execPath,
    projectRoot: opts.projectRoot,
    host,
    port,
    authToken: opts.authToken ?? null,
  });
  const target = installAgent(SERVER_AGENT_LABEL, plist, resolve(opts.projectRoot, "data/server.log"), opts.runtime);
  return `Installed ${SERVER_AGENT_LABEL} (http://${host}:${port}) -> ${target}`;
};

export const uninstallServer = (runtime?: CronRuntime): string => uninstallAgent(SERVER_AGENT_LABEL, runtime);

export const serverStatus = (projectRoot: string, runtime?: CronRuntime): string =>
  agentStatus(SERVER_AGENT_LABEL, resolve(projectRoot, "data/server.log"), runtime);

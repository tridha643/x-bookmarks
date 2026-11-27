import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPlist,
  buildServerPlist,
  cronStatus,
  installCron,
  installServer,
  parseIntervalSeconds,
  serverStatus,
  uninstallCron,
  uninstallServer,
} from "./launchd.ts";

describe("adapters/cron/launchd", () => {
  it("parses interval strings with units and enforces >= 60s minimum", () => {
    expect(parseIntervalSeconds(undefined)).toBe(86_400);
    expect(parseIntervalSeconds("60s")).toBe(60);
    expect(parseIntervalSeconds("15m")).toBe(900);
    expect(parseIntervalSeconds("30")).toBe(1800);
    expect(parseIntervalSeconds("24h")).toBe(86_400);
    expect(parseIntervalSeconds("2d")).toBe(172_800);
    expect(() => parseIntervalSeconds("30s")).toThrow(/at least 60 seconds/);
    expect(() => parseIntervalSeconds("invalid")).toThrow(/Invalid interval/);
    expect(() => parseIntervalSeconds("15m extra")).toThrow(/Invalid interval/);
    expect(() => parseIntervalSeconds("pre 15m")).toThrow(/Invalid interval/);
  });

  it("renders valid launchd plist XML with escaped paths and optional flags", () => {
    const xml = buildPlist({
      nodeBin: "/opt/homebrew/bin/node",
      projectRoot: `/Users/dev/x&b <t> "q" 'a'`,
      intervalSeconds: 86_400,
      runAtLoad: true,
      threads: true,
    });
    expect(xml).toContain("<string>com.xbookmarks.sync</string>");
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain(`<string>/Users/dev/x&amp;b &lt;t&gt; &quot;q&quot; &apos;a&apos;/src/main.ts</string>`);
    expect(xml).toContain(`<string>/Users/dev/x&amp;b &lt;t&gt; &quot;q&quot; &apos;a&apos;/data/cron.log</string>`);
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>\n    <string>");
    expect(xml).toContain("<string>sync</string>\n    <string>--threads</string>");
    expect(xml).toContain("<integer>86400</integer>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain(
      "<key>PATH</key>\n    <string>/opt/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>",
    );

    const noThreads = buildPlist({
      nodeBin: "/usr/local/bin/node",
      projectRoot: "/srv/xbm",
      intervalSeconds: 3600,
      runAtLoad: false,
      threads: false,
    });
    expect(noThreads).not.toContain("--threads");
    expect(noThreads).toContain("<false/>");

    const srvXml = buildServerPlist({
      nodeBin: "/opt/homebrew/bin/node",
      projectRoot: "/srv/xbm",
      host: "127.0.0.1",
      port: 8787,
      authToken: "tok-123",
    });
    expect(srvXml).toContain("<string>com.xbookmarks.server</string>");
    expect(srvXml).toContain("<string>/srv/xbm/src/main.ts</string>");
    expect(srvXml).toContain("<string>serve</string>");
    expect(srvXml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(srvXml).toContain(
      "<key>PATH</key>\n    <string>/opt/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>\n    <key>XBM_HTTP_HOST</key>",
    );
    expect(srvXml).toContain("<key>XBM_HTTP_HOST</key>\n    <string>127.0.0.1</string>");
    expect(srvXml).toContain("<key>XBM_HTTP_PORT</key>\n    <string>8787</string>");
    expect(srvXml).toContain("<key>XBM_AUTH_TOKEN</key>\n    <string>tok-123</string>");
    expect(srvXml).toContain("<string>/srv/xbm/data/server.log</string>");

    const srvNoAuth = buildServerPlist({
      nodeBin: "/opt/homebrew/bin/node",
      projectRoot: "/srv/xbm",
      host: "127.0.0.1",
      port: 8787,
      authToken: "",
    });
    expect(srvNoAuth).not.toContain("XBM_AUTH_TOKEN");
  });

  it("installs, inspects status (with log tail), and uninstalls LaunchAgent via injected runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "xbm-cron-test-"));
    const homeDir = join(root, "home");
    const projectRoot = join(root, "proj");
    const cmds: Array<ReadonlyArray<string>> = [];

    try {
      // Missing POSIX uid throws on install and uninstall
      expect(() => installCron({ projectRoot, runtime: { homeDir, uid: null } })).toThrow(/POSIX uid/);
      expect(() => uninstallCron({ homeDir, uid: null })).toThrow(/POSIX uid/);

      // Uninstall when not installed
      expect(
        uninstallCron({
          homeDir,
          uid: 501,
          execLaunchctl: (args) => {
            cmds.push(args);
            return { ok: true, output: "" };
          },
        }),
      ).toBe("LaunchAgent was not installed.");
      expect(cmds).toEqual([["bootout", "gui/501/com.xbookmarks.sync"]]);

      // Status when not installed and not loaded
      const stEmpty = cronStatus(projectRoot, {
        homeDir,
        uid: 501,
        execLaunchctl: () => ({ ok: false, output: "not found" }),
      });
      expect(stEmpty).toContain("Plist: (not installed)");
      expect(stEmpty).toContain("Status: not loaded");

      // Status without uid omits Status line
      const stNoUid = cronStatus(projectRoot, { homeDir, uid: null });
      expect(stNoUid).not.toContain("Status:");

      // Install failure throws bootstrap error
      expect(() =>
        installCron({
          projectRoot,
          runtime: {
            homeDir,
            uid: 501,
            nodeBin: "/opt/bin/node",
            execLaunchctl: (args) =>
              args[0] === "bootstrap" ? { ok: false, output: "denied" } : { ok: true, output: "" },
          },
        }),
      ).toThrow(/launchctl bootstrap failed: denied/);

      // Successful install writes plist with defaults (24h, runAtLoad=false, threads=true)
      cmds.length = 0;
      const msg = installCron({
        projectRoot,
        runtime: {
          homeDir,
          uid: 501,
          nodeBin: "/opt/bin/node",
          execLaunchctl: (args) => {
            cmds.push(args);
            return { ok: true, output: "ok" };
          },
        },
      });
      const expectedPlist = join(homeDir, "Library/LaunchAgents/com.xbookmarks.sync.plist");
      expect(msg).toBe(`Installed com.xbookmarks.sync (every 86400s) -> ${expectedPlist}`);
      expect(existsSync(expectedPlist)).toBe(true);
      expect(existsSync(join(projectRoot, "data"))).toBe(true);
      const plistText = readFileSync(expectedPlist, "utf8");
      expect(plistText).toContain("<false/>");
      expect(plistText).toContain("--threads");
      expect(cmds).toEqual([
        ["bootout", "gui/501/com.xbookmarks.sync"],
        ["bootstrap", "gui/501", expectedPlist],
      ]);

      // Status when installed + loaded + 15-line log file shows last 10 lines
      const logLines = Array.from({ length: 15 }, (_, i) => `line-${i + 1}`).join("\n");
      writeFileSync(join(projectRoot, "data/cron.log"), logLines, "utf8");
      const statusCmds: Array<ReadonlyArray<string>> = [];
      const stLoaded = cronStatus(projectRoot, {
        homeDir,
        uid: 501,
        execLaunchctl: (args) => {
          statusCmds.push(args);
          return { ok: true, output: "" };
        },
      });
      expect(statusCmds).toEqual([["print", "gui/501/com.xbookmarks.sync"]]);
      expect(stLoaded.split("\n")[0]).toBe("LaunchAgent: com.xbookmarks.sync");
      expect(stLoaded).toContain(`Plist: ${expectedPlist}`);
      expect(stLoaded).toContain("Status: loaded");
      expect(stLoaded).not.toContain("  line-5\n");
      expect(stLoaded).toContain("  line-6\n");
      expect(stLoaded).toContain("  line-15");

      // Uninstall removes plist file
      const unMsg = uninstallCron({
        homeDir,
        uid: 501,
        execLaunchctl: () => ({ ok: true, output: "" }),
      });
      expect(unMsg).toBe(`Unloaded and removed ${expectedPlist}`);
      expect(existsSync(expectedPlist)).toBe(false);

      // Persistent HTTP/MCP server LaunchAgent lifecycle (install, status, uninstall)
      const srvRoot = join(root, "srv-proj");
      const srvCmds: Array<ReadonlyArray<string>> = [];
      const srvMsg = installServer({
        projectRoot: srvRoot,
        runtime: {
          homeDir,
          uid: 501,
          nodeBin: "/opt/bin/node",
          execLaunchctl: (args) => {
            srvCmds.push(args);
            return { ok: true, output: "ok" };
          },
        },
      });
      const expectedSrvPlist = join(homeDir, "Library/LaunchAgents/com.xbookmarks.server.plist");
      expect(srvMsg).toBe(`Installed com.xbookmarks.server (http://127.0.0.1:8787) -> ${expectedSrvPlist}`);
      expect(existsSync(expectedSrvPlist)).toBe(true);
      expect(existsSync(join(srvRoot, "data"))).toBe(true);
      expect(srvCmds).toEqual([
        ["bootout", "gui/501/com.xbookmarks.server"],
        ["bootstrap", "gui/501", expectedSrvPlist],
      ]);

      writeFileSync(join(srvRoot, "data/server.log"), "listening on 8787\n", "utf8");
      const srvSt = serverStatus(srvRoot, {
        homeDir,
        uid: 501,
        execLaunchctl: () => ({ ok: true, output: "" }),
      });
      expect(srvSt).toContain("LaunchAgent: com.xbookmarks.server");
      expect(srvSt).toContain("Status: loaded");
      expect(srvSt).toContain("  listening on 8787");

      expect(
        uninstallServer({
          homeDir,
          uid: 501,
          execLaunchctl: () => ({ ok: true, output: "" }),
        }),
      ).toBe(`Unloaded and removed ${expectedSrvPlist}`);
      expect(existsSync(expectedSrvPlist)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

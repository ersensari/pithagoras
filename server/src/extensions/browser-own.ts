import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The owner's own Chrome, with its real profile and logins, as the agent's browser.
 *
 * Chrome 136+ ignores --remote-debugging-port on the default profile, so this
 * never starts Chrome with that flag. The owner turns on remote debugging at
 * chrome://inspect/#remote-debugging; Chrome then writes DevToolsActivePort into
 * the profile directory: line 1 is the port, line 2 the browser's websocket path.
 * Playwright must be given the websocket URL, since /json/version answers 404 in
 * this mode.
 */

export const OWN_CHROME_NOT_OPEN =
  'Your own Chrome is not open for the agent. Open Chrome, go to chrome://inspect/#remote-debugging, turn on "Allow remote debugging for this browser instance", and click Allow when Chrome asks.';

export interface DebugEndpoint {
  port: number;
  ws: string;
}

/** BROWSER_OWN_CHROME=1 (or true) puts the agent on the owner's Chrome. Off by default. */
export function ownChromeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BROWSER_OWN_CHROME?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Where Chrome keeps its default profile on this platform. */
export function defaultProfileDir(platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  }
  return path.posix.join(home, ".config", "google-chrome");
}

/** The profile directory to read: BROWSER_OWN_PROFILE when set, else the platform default. */
export function ownProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BROWSER_OWN_PROFILE || defaultProfileDir();
}

/** Parses the DevToolsActivePort file: line 1 the port, line 2 the browser websocket path. */
export function parseActivePort(text: string): DebugEndpoint | null {
  const [first, second] = text.split(/\r?\n/);
  const portText = first?.trim() ?? "";
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const wsPath = second?.trim() ?? "";
  if (!wsPath.startsWith("/")) return null;
  return { port, ws: `ws://127.0.0.1:${port}${wsPath}` };
}

/** The debugging endpoint Chrome published in this profile, or null when there is none. */
export function readDebugEndpoint(dir: string): DebugEndpoint | null {
  let text: string;
  try {
    text = readFileSync(path.join(dir, "DevToolsActivePort"), "utf8");
  } catch {
    return null;
  }
  return parseActivePort(text);
}

/** Whether Chrome has published its debugging endpoint in this profile. */
export function ownChromeReady(dir: string = ownProfileDir()): boolean {
  return existsSync(path.join(dir, "DevToolsActivePort"));
}

/**
 * The endpoint, if Chrome has one. When the file is missing on macOS, Chrome is
 * opened once (never with a debugging flag) and this waits up to `timeoutMs`
 * for the file. Null when it still is not there.
 */
export async function waitForOwnEndpoint(
  dir: string = ownProfileDir(),
  { platform = process.platform, timeoutMs = 8000 }: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<DebugEndpoint | null> {
  const found = readDebugEndpoint(dir);
  if (found) return found;
  if (platform !== "darwin" || ownChromeReady(dir)) return null;
  try {
    const child = spawn("open", ["-a", "Google Chrome"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    return null;
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    const endpoint = readDebugEndpoint(dir);
    if (endpoint) return endpoint;
  }
  return null;
}

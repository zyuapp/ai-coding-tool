import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { importSites, type BrowserImportResult, type BrowserImportSite, type BrowserImportSource } from "../domain/browser-import.js";
import { chromiumKey, readCookieHosts, readCookies, type ChromiumKeys, type CookieFamily, type StoredCookie } from "./browser-cookies.js";

/**
 * A browser this machine may have. `roots` are its user-data folders, every packaging of it
 * included. `keychain` names its macOS key; `libsecret` and `kwallet` name where Linux keeps it.
 */
type BrowserKind = {
  key: string;
  name: string;
  family: CookieFamily;
  roots: string[];
  keychain?: string;
  libsecret?: string;
  kwallet?: string;
};

type ResolvedSource = BrowserImportSource & { kind: BrowserKind; file: string };

function catalog(platform: NodeJS.Platform, home: string, configHome: string | undefined): BrowserKind[] {
  if (platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    const chromium = (key: string, name: string, folder: string, keychain = `${name} Safe Storage`): BrowserKind =>
      ({ key, name, family: "chromium", roots: [path.join(support, folder)], keychain });
    return [
      chromium("chrome", "Chrome", "Google/Chrome"),
      chromium("brave", "Brave", "BraveSoftware/Brave-Browser"),
      chromium("edge", "Microsoft Edge", "Microsoft Edge"),
      chromium("arc", "Arc", "Arc/User Data"),
      chromium("vivaldi", "Vivaldi", "Vivaldi"),
      chromium("opera", "Opera", "com.operasoftware.Opera"),
      chromium("chromium", "Chromium", "Chromium"),
      { key: "firefox", name: "Firefox", family: "firefox", roots: [path.join(support, "Firefox")] },
    ];
  }
  if (platform === "linux") {
    const config = configHome || path.join(home, ".config");
    const flatpak = (app: string, ...rest: string[]) => path.join(home, ".var", "app", app, ...rest);
    const chromium = (key: string, name: string, roots: string[], libsecret: string, kwallet = name): BrowserKind =>
      ({ key, name, family: "chromium", roots, libsecret, kwallet });
    return [
      chromium("chrome", "Chrome", [path.join(config, "google-chrome"), flatpak("com.google.Chrome", "config", "google-chrome")], "chrome"),
      chromium("brave", "Brave", [
        path.join(config, "BraveSoftware", "Brave-Browser"),
        flatpak("com.brave.Browser", "config", "BraveSoftware", "Brave-Browser"),
        path.join(home, "snap", "brave", "current", ".config", "BraveSoftware", "Brave-Browser"),
      ], "brave"),
      /** Edge and Opera keep their key under Chromium's name on Linux, and Vivaldi under Chrome's. */
      chromium("edge", "Microsoft Edge", [path.join(config, "microsoft-edge"), flatpak("com.microsoft.Edge", "config", "microsoft-edge")], "chromium", "Chromium"),
      chromium("vivaldi", "Vivaldi", [path.join(config, "vivaldi"), flatpak("com.vivaldi.Vivaldi", "config", "vivaldi")], "chrome", "Chrome"),
      chromium("opera", "Opera", [path.join(config, "opera")], "chromium", "Chromium"),
      chromium("chromium", "Chromium", [
        path.join(config, "chromium"),
        path.join(home, "snap", "chromium", "common", "chromium"),
        flatpak("org.chromium.Chromium", "config", "chromium"),
      ], "chromium"),
      { key: "firefox", name: "Firefox", family: "firefox", roots: [
        path.join(home, ".mozilla", "firefox"),
        path.join(config, "mozilla", "firefox"),
        path.join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
        flatpak("org.mozilla.firefox", ".mozilla", "firefox"),
        flatpak("org.mozilla.firefox", "config", "mozilla", "firefox"),
      ] },
    ];
  }
  return [];
}

function chromiumCookieFile(profile: string) {
  return [path.join(profile, "Network", "Cookies"), path.join(profile, "Cookies")].find((file) => existsSync(file));
}

async function chromiumProfiles(kind: BrowserKind, root: string, rootIndex: number): Promise<ResolvedSource[]> {
  const found: ResolvedSource[] = [];
  const add = (folder: string, profile: string) => {
    const file = chromiumCookieFile(path.join(root, folder));
    if (file) found.push({ id: `${kind.key}:${rootIndex}:${folder}`, browser: kind.name, profile, kind, file });
  };
  try {
    const state = JSON.parse(await readFile(path.join(root, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: unknown }> } };
    for (const [folder, info] of Object.entries(state.profile?.info_cache ?? {})) {
      if (folder.includes("/") || folder.includes("\\") || folder.startsWith(".")) continue;
      add(folder, typeof info.name === "string" && info.name ? info.name : folder);
    }
  } catch {
    /** No list of profiles leaves the usual one, or the folder itself the way Opera keeps it. */
  }
  if (!found.length) add("Default", "Default");
  if (!found.length) add(".", "Default");
  return found;
}

/** The [Profile…] sections of a Firefox profiles.ini, the default one first. */
export function firefoxProfileEntries(ini: string) {
  const sections: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const line of ini.split(/\r?\n/)) {
    const heading = /^\s*\[(.+)\]\s*$/.exec(line);
    if (heading) {
      current = { section: heading[1]! };
      sections.push(current);
    } else if (current) {
      const pair = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
      if (pair) current[pair[1]!] = pair[2]!;
    }
  }
  const installed = new Set(sections.filter((section) => section.section!.startsWith("Install") && section.Default).map((section) => section.Default));
  return sections
    .filter((section) => section.section!.startsWith("Profile") && section.Path)
    .sort((left, right) => Number(installed.has(right.Path)) - Number(installed.has(left.Path)));
}

async function firefoxProfiles(kind: BrowserKind, root: string, rootIndex: number): Promise<ResolvedSource[]> {
  let ini: string;
  try {
    ini = await readFile(path.join(root, "profiles.ini"), "utf8");
  } catch {
    return [];
  }
  return firefoxProfileEntries(ini).flatMap((entry) => {
    const folder = entry.IsRelative === "0" ? entry.Path! : path.join(root, entry.Path!);
    const file = path.join(folder, "cookies.sqlite");
    if (!existsSync(file)) return [];
    return [{ id: `${kind.key}:${rootIndex}:${entry.Path}`, browser: kind.name, profile: entry.Name || path.basename(folder), kind, file }];
  });
}

export async function discover(platform = process.platform, home = homedir(), configHome = process.env.XDG_CONFIG_HOME): Promise<ResolvedSource[]> {
  const kinds = catalog(platform, home, configHome);
  const found = await Promise.all(kinds.flatMap((kind) => kind.roots.map((root, index) => {
    if (!existsSync(root)) return [];
    return kind.family === "firefox" ? firefoxProfiles(kind, root, index) : chromiumProfiles(kind, root, index);
  })));
  return found.flat();
}

/** The browser profiles on this machine that hold cookies. */
export async function listImportSources(): Promise<BrowserImportSource[]> {
  return (await discover()).map(({ id, browser, profile }) => ({ id, browser, profile }));
}

/** An id is only ever matched against what is on disk now, so nothing a caller sends becomes a path. */
async function resolve(sourceId: string): Promise<ResolvedSource> {
  const source = (await discover()).find((item) => item.id === sourceId);
  if (!source) throw new Error("That browser profile is no longer on this computer.");
  return source;
}

export async function listImportSites(sourceId: string): Promise<BrowserImportSite[]> {
  const source = await resolve(sourceId);
  return importSites(await readCookieHosts(source.kind.family, source.file));
}

function run(command: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, encoding: "utf8" }, (error, stdout) => resolve(error ? null : stdout.replace(/\n$/, "")));
  });
}

/** The KDE wallet Chromium stores its key in, which the user may have renamed from the default. */
async function networkWallet() {
  for (const service of ["kwalletd6", "kwalletd5"]) {
    const name = await run("dbus-send", ["--session", "--print-reply=literal", `--dest=org.kde.${service}`, `/modules/${service}`, "org.kde.KWallet.networkWallet"], 5_000);
    if (name?.trim()) return name.trim();
  }
  return "kdewallet";
}

/**
 * Where each platform keeps the password a Chromium browser encrypts cookies with. macOS asks the
 * user before handing it over. Linux falls back to the fixed password Chromium uses without a keyring.
 */
function chromiumKeys(kind: BrowserKind): ChromiumKeys {
  return async (version) => {
    if (process.platform === "darwin") {
      const password = await run("security", ["find-generic-password", "-w", "-s", kind.keychain!], 120_000);
      if (password === null) throw new Error(`macOS did not share ${kind.name}'s key. Choose Allow when it asks.`);
      return [chromiumKey(password, 1003)];
    }
    if (version === "v10") return [chromiumKey("peanuts", 1)];
    const wallet = await networkWallet();
    const passwords = [
      await run("secret-tool", ["lookup", "application", kind.libsecret!], 30_000),
      await run("kwallet-query", ["--read-password", `${kind.kwallet} Safe Storage`, "--folder", `${kind.kwallet} Keys`, wallet], 30_000),
      "",
    ].filter((password): password is string => password !== null);
    return [...new Set(passwords)].map((password) => chromiumKey(password, 1));
  };
}

/** The cookies for those sites, read from that profile and decrypted. */
async function readImportCookies(sourceId: string, sites: string[]): Promise<{ cookies: StoredCookie[]; skipped: number }> {
  const source = await resolve(sourceId);
  return readCookies(source.kind.family, source.file, sites, chromiumKeys(source.kind));
}

/** What Electron needs to set one cookie the way the other browser held it. */
export function cookieDetails(cookie: StoredCookie): Electron.CookiesSetDetails {
  const host = cookie.host.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path.startsWith("/") ? cookie.path : "/"}`,
    name: cookie.name,
    value: cookie.value,
    /** A host without a leading dot is host-only, which leaving the domain out keeps it. */
    ...(cookie.host.startsWith(".") ? { domain: cookie.host } : {}),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expires === null ? {} : { expirationDate: cookie.expires }),
  };
}

/** Reads those sites' cookies from the profile and hands them to `add`, which answers how many it set. */
export async function importBrowserSites(sourceId: string, sites: string[], add: (cookies: Electron.CookiesSetDetails[], sites: string[]) => Promise<number>): Promise<BrowserImportResult> {
  const { cookies, skipped } = await readImportCookies(sourceId, sites);
  const imported = await add(cookies.map(cookieDetails), sites);
  return { imported, skipped: skipped + cookies.length - imported };
}

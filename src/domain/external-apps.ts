/** The applications AI Coding Tool can hand a checkout to, and where each of them lives per platform. */

import type { Platform } from "./editors.js";

/** What an application is for, which is how the list groups them. */
export type ExternalAppKind = "editor" | "terminal" | "files";

export type AppLaunch = {
  command: string;
  args: string[];
};

/**
 * One place an application might be, and the command that opens a folder there. A candidate with a
 * `probe` exists only if that path does; one without is looked up on PATH instead.
 */
export type AppCandidate = AppLaunch & {
  id: string;
  probe: string | null;
  /** The bundle the application's own icon is read from. Only macOS keeps one where this can find it. */
  icon: string | null;
};

export type ExternalApp = {
  id: string;
  label: string;
  kind: ExternalAppKind;
};

/** A macOS bundle, named on its own so every standard folder is searched for it. */
type BundleLocation = {
  bundle: string;
  /** A bundle-specific launcher for applications that need more than a folder-open event. */
  launch?: (bundle: string, folder: string) => AppLaunch;
};

/** A launcher, resolved on PATH by a bare name or given as an absolute path. */
type CommandLocation = {
  command: string;
  args?: (folder: string) => string[];
  /** The bundle to read the icon from, for an application the platform opens by another name. */
  icon?: string;
};

type Location = BundleLocation | CommandLocation;

type CataloguedApp = ExternalApp & {
  /** Ways to open a folder on each platform, in the order they are worth trying. */
  locations: Partial<Record<Platform, Location[]>>;
};

/** Where macOS keeps applications, beyond the user's own folder, which is added per home directory. */
const BUNDLE_FOLDERS = ["/Applications", "/System/Applications", "/System/Applications/Utilities"];

/**
 * The catalog, in the order the list draws it. Editors come first because reading a checkout is the
 * common reason to leave the app at all, and the file manager comes last because it always answers.
 */
const APPS: CataloguedApp[] = [
  {
    id: "cursor",
    label: "Cursor",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Cursor.app" }],
      win32: [{ command: "cursor.cmd" }],
      linux: [{ command: "cursor" }],
    },
  },
  {
    id: "vscode",
    label: "Visual Studio Code",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Visual Studio Code.app" }],
      win32: [{ command: "code.cmd" }],
      linux: [{ command: "code" }],
    },
  },
  {
    id: "vscode-insiders",
    label: "Visual Studio Code Insiders",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Visual Studio Code - Insiders.app" }],
      win32: [{ command: "code-insiders.cmd" }],
      linux: [{ command: "code-insiders" }],
    },
  },
  {
    id: "vscodium",
    label: "VSCodium",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "VSCodium.app" }],
      win32: [{ command: "codium.cmd" }],
      linux: [{ command: "codium" }],
    },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Windsurf.app" }],
      win32: [{ command: "windsurf.cmd" }],
      linux: [{ command: "windsurf" }],
    },
  },
  {
    id: "zed",
    label: "Zed",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Zed.app" }],
      linux: [{ command: "zed" }],
    },
  },
  {
    id: "sublime",
    label: "Sublime Text",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Sublime Text.app" }],
      win32: [{ command: "subl.exe" }],
      linux: [{ command: "subl" }],
    },
  },
  {
    id: "intellij",
    label: "IntelliJ IDEA",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "IntelliJ IDEA.app" }],
      win32: [{ command: "idea.bat" }],
      linux: [{ command: "idea" }],
    },
  },
  {
    id: "webstorm",
    label: "WebStorm",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "WebStorm.app" }],
      win32: [{ command: "webstorm.bat" }],
      linux: [{ command: "webstorm" }],
    },
  },
  {
    id: "pycharm",
    label: "PyCharm",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "PyCharm.app" }, { bundle: "PyCharm CE.app" }],
      win32: [{ command: "pycharm64.exe" }],
      linux: [{ command: "pycharm" }, { command: "pycharm.sh" }],
    },
  },
  {
    id: "goland",
    label: "GoLand",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "GoLand.app" }],
      win32: [{ command: "goland64.exe" }],
      linux: [{ command: "goland" }, { command: "goland.sh" }],
    },
  },
  {
    id: "clion",
    label: "CLion",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "CLion.app" }],
      win32: [{ command: "clion64.exe" }],
      linux: [{ command: "clion" }, { command: "clion.sh" }],
    },
  },
  {
    id: "rider",
    label: "Rider",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Rider.app" }],
      win32: [{ command: "rider64.exe" }],
      linux: [{ command: "rider" }, { command: "rider.sh" }],
    },
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "PhpStorm.app" }],
      win32: [{ command: "phpstorm64.exe" }],
      linux: [{ command: "phpstorm" }, { command: "phpstorm.sh" }],
    },
  },
  {
    id: "rubymine",
    label: "RubyMine",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "RubyMine.app" }],
      win32: [{ command: "rubymine64.exe" }],
      linux: [{ command: "rubymine" }, { command: "rubymine.sh" }],
    },
  },
  {
    id: "rustrover",
    label: "RustRover",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "RustRover.app" }],
      win32: [{ command: "rustrover64.exe" }],
      linux: [{ command: "rustrover" }, { command: "rustrover.sh" }],
    },
  },
  {
    id: "xcode",
    label: "Xcode",
    kind: "editor",
    locations: {
      darwin: [{
        bundle: "Xcode.app",
        launch: (bundle, folder) => ({
          command: `${bundle}/Contents/Developer/usr/bin/xed`,
          args: ["--project", folder],
        }),
      }],
    },
  },
  {
    id: "android-studio",
    label: "Android Studio",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "Android Studio.app" }],
      win32: [{ command: "studio64.exe" }],
      linux: [{ command: "studio" }, { command: "studio.sh" }, { command: "android-studio" }],
    },
  },
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    kind: "editor",
    locations: {
      darwin: [{ bundle: "GitHub Desktop.app" }],
      win32: [{ command: "github.exe" }],
      linux: [{ command: "github-desktop" }],
    },
  },
  {
    id: "terminal",
    label: "Terminal",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "Terminal.app" }],
    },
  },
  {
    id: "iterm",
    label: "iTerm",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "iTerm.app" }],
    },
  },
  {
    id: "warp",
    label: "Warp",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "Warp.app" }],
      linux: [{ command: "warp-terminal" }],
    },
  },
  {
    id: "ghostty",
    label: "Ghostty",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "Ghostty.app" }],
      linux: [{ command: "ghostty", args: (folder) => [`--working-directory=${folder}`] }],
    },
  },
  {
    id: "cmux",
    label: "cmux",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "cmux.app" }],
    },
  },
  {
    id: "kitty",
    label: "kitty",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "kitty.app" }],
      linux: [{ command: "kitty", args: (folder) => ["--directory", folder] }],
    },
  },
  {
    id: "wezterm",
    label: "WezTerm",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "WezTerm.app" }],
      linux: [{ command: "wezterm", args: (folder) => ["start", "--cwd", folder] }],
    },
  },
  {
    id: "alacritty",
    label: "Alacritty",
    kind: "terminal",
    locations: {
      darwin: [{ bundle: "Alacritty.app" }],
      linux: [{ command: "alacritty", args: (folder) => ["--working-directory", folder] }],
    },
  },
  {
    id: "tabby",
    label: "Tabby",
    kind: "terminal",
    locations: {
      darwin: [{
        bundle: "Tabby.app",
        launch: (bundle, folder) => ({
          command: `${bundle}/Contents/MacOS/Tabby`,
          args: ["open", folder],
        }),
      }],
      win32: [{ command: "Tabby.exe", args: (folder) => ["open", folder] }],
      linux: [{ command: "tabby", args: (folder) => ["open", folder] }],
    },
  },
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    kind: "terminal",
    locations: {
      win32: [{ command: "wt.exe", args: (folder) => ["-d", folder] }],
    },
  },
  {
    id: "gnome-terminal",
    label: "GNOME Terminal",
    kind: "terminal",
    locations: {
      linux: [{ command: "gnome-terminal", args: (folder) => [`--working-directory=${folder}`] }],
    },
  },
  {
    id: "konsole",
    label: "Konsole",
    kind: "terminal",
    locations: {
      linux: [{ command: "konsole", args: (folder) => ["--workdir", folder] }],
    },
  },
  {
    id: "finder",
    label: "Finder",
    kind: "files",
    locations: {
      darwin: [{ command: "open", icon: "/System/Library/CoreServices/Finder.app" }],
    },
  },
  {
    id: "explorer",
    label: "File Explorer",
    kind: "files",
    locations: {
      win32: [{ command: "explorer.exe" }],
    },
  },
  {
    id: "file-manager",
    label: "File manager",
    kind: "files",
    locations: {
      linux: [{ command: "xdg-open" }],
    },
  },
];

/** The folders a bare bundle name is searched in, the user's own last. */
function bundlePaths(bundle: string, home: string) {
  return [...BUNDLE_FOLDERS, `${home}/Applications`].map((folder) => `${folder}/${bundle}`);
}

function candidatesFor(app: CataloguedApp, platform: Platform, home: string, folder: string): AppCandidate[] {
  return (app.locations[platform] ?? []).flatMap((location) => {
    if ("bundle" in location) {
      return bundlePaths(location.bundle, home).map((path) => {
        const launch = location.launch
          ? location.launch(path, folder)
          : { command: "open", args: ["-a", path, folder] };
        return { id: app.id, probe: path, icon: path, ...launch };
      });
    }
    return [{
      id: app.id,
      probe: location.command.startsWith("/") ? location.command : null,
      icon: location.icon ?? null,
      command: location.command,
      args: location.args ? location.args(folder) : [folder],
    }];
  });
}

/** Every application the catalog knows on this platform, in the order the list draws them. */
export function externalApps(platform: Platform): ExternalApp[] {
  return APPS
    .filter((app) => (app.locations[platform] ?? []).length > 0)
    .map(({ id, label, kind }) => ({ id, label, kind }));
}

/** Every place one application might be on this platform, best first. */
export function appCandidates(appId: string, platform: Platform, home: string, folder: string): AppCandidate[] {
  const app = APPS.find((candidate) => candidate.id === appId);
  return app ? candidatesFor(app, platform, home, folder) : [];
}

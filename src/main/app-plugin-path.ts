import path from "node:path";

/** Where the app's plugin sits: beside the other resources when packaged, in the source tree in development. */
export function appPluginPath(isPackaged: boolean, resourcesPath: string, appPath: string) {
  return isPackaged ? path.join(resourcesPath, "app-plugin") : path.join(appPath, "assets", "app-plugin");
}

/** Asks the user for a folder with the system picker, answering with null when they cancel. */
export function pickFolder() {
  return window.desktop.openFolder();
}

if (window.workspace?.owner) {
  void import("./workspace-runtime-entry");
} else {
  void import("./app-entry");
}

export {};

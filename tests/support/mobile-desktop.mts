import { emptyMobileServerState } from "../../src/domain/mobile.ts";
import type { MobileDesktopAPI } from "../../src/contracts/mobile.ts";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { SettingsPanelProps } from "../../src/renderer/components/SettingsPanel.tsx";

/** The phone bridge as a window that never runs one: off, with nothing paired and nothing connected. */
export const mobileDesktopStub: MobileDesktopAPI & Pick<DesktopAPI, "platform" | "loadThreadMessages" | "terminalSnapshot"> = {
  platform: "macos",
  loadThreadMessages: async () => [],
  terminalSnapshot: async () => null,
  mobileState: async () => emptyMobileServerState(),
  setMobileEnabled: async () => emptyMobileServerState(),
  createMobilePairingCode: async () => ({
    code: "PAIR1234",
    expiresAt: 0,
    address: { kind: "loopback", host: "127.0.0.1", port: 7737 },
    url: "http://127.0.0.1:7737/m?pair=PAIR1234",
  }),
  revokeMobileDevice: async () => emptyMobileServerState(),
  refreshTailscale: async () => emptyMobileServerState(),
  onMobileState: () => () => {},
  onMobileRequest: () => () => {},
  answerMobileRequest() {},
  publishMobileView() {},
};

/** Every engine ready, and a sign-in that changes nothing, for tests that are not about engines. */
export const engineDesktopStub: Pick<DesktopAPI, "engineStatus" | "signInEngine" | "inspectBrowserPage" | "openSourceLicenses"> = {
  engineStatus: async () => ({ codex: { access: "ready" } }),
  signInEngine: async () => ({ codex: { access: "ready" } }),
  inspectBrowserPage: async () => null,
  openSourceLicenses: async () => {},
};

/** The same for the settings panel, whose phone page is not what any of these tests are about. */
export const mobileSettingsProps: Pick<SettingsPanelProps, "remote" | "onSetRemoteEnabled" | "onCreateRemotePairingCode" | "onRevokeRemoteDevice" | "onRefreshRemote"> = {
  remote: emptyMobileServerState(),
  onSetRemoteEnabled() {},
  onCreateRemotePairingCode() {},
  onRevokeRemoteDevice() {},
  onRefreshRemote() {},
};

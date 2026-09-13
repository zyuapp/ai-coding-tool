import type { ComputerDesktop } from "./runtime-desktop.js";

/** A host that pairs with no other computer: nothing is found, nothing is held, and nothing is carried. */
export const noComputers: ComputerDesktop = {
  discoverComputers: async () => [],
  pairComputer: async () => { throw new Error("This computer cannot pair with others."); },
  forgetComputer: async () => {},
  sendToComputer: async () => ({ ok: false, message: "This computer holds no other computer's threads." }),
  onComputersChanged: () => () => {},
  onComputerState: () => () => {},
  onComputerNotice: () => () => {},
};

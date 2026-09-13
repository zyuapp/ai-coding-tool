import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import type { AppCommand } from "../../contracts/commands";
import { REMOTE_UNSUPPORTED } from "../../contracts/computer-capabilities";

export type CommandControls = {
  available: (command: AppCommand) => boolean;
  dispatch: (command: AppCommand) => void;
};

/** Standalone views and the host-served phone have no independently versioned computer selected. */
const CommandContext = createContext<CommandControls>({ available: () => true, dispatch: () => {} });
export const CommandControlsProvider = CommandContext.Provider;
export const useCommandControls = () => useContext(CommandContext);

/** A new remote button declares its command once; availability and dispatch follow the shared contract. */
export function CommandButton({ command, disabled, onClick, title, ...props }: ComponentProps<"button"> & { command: AppCommand }) {
  const controls = useCommandControls();
  const unavailable = !controls.available(command);
  return <button {...props} disabled={disabled || unavailable} title={unavailable ? REMOTE_UNSUPPORTED : title}
    onClick={onClick ?? (() => controls.dispatch(command))} />;
}

/** A group that offers one operation, such as a setting picker, disappears when its host lacks it. */
export function CommandGate({ command, children }: { command: AppCommand; children: ReactNode }) {
  return useCommandControls().available(command) ? children : null;
}

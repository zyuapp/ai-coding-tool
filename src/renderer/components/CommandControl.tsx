import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import type { AppCommand } from "../../contracts/commands";
import { REMOTE_UNSUPPORTED } from "../../contracts/computer-capabilities";
import { Button, IconButton, type ButtonLook, type IconButtonProps } from "../ui/Button";

export type CommandControls = {
  available: (command: AppCommand) => boolean;
  dispatch: (command: AppCommand) => void;
};

/** Standalone views and the host-served phone have no independently versioned computer selected. */
const CommandContext = createContext<CommandControls>({ available: () => true, dispatch: () => {} });
export const CommandControlsProvider = CommandContext.Provider;
export const useCommandControls = () => useContext(CommandContext);

type CommandState = ComponentProps<"button"> & Record<`data-${string}`, string>;

/** One its computer cannot run stays focusable, so the keyboard and a press both reach the reason. */
function useCommandState(command: AppCommand, disabled: boolean | undefined, onClick: ComponentProps<"button">["onClick"]): CommandState {
  const controls = useCommandControls();
  if (!disabled && !controls.available(command)) return { type: "button", title: undefined, "aria-disabled": "true", "data-unsupported": "", "data-tip": REMOTE_UNSUPPORTED };
  return { disabled, onClick: onClick ?? (() => controls.dispatch(command)) };
}

/** A new remote button declares its command once; availability and dispatch follow the shared contract. */
export function CommandButton({ command, disabled, onClick, variant, size, pill, icon, busy, armed, tone, ...props }: ComponentProps<"button"> & ButtonLook & { command: AppCommand }) {
  const state = useCommandState(command, disabled, onClick);
  const look = { variant, size, pill, icon, busy, armed, tone };
  /** With any look given it draws as a `Button`; without one it stays a bare button its container styles. */
  const styled = Object.values(look).some((value) => value !== undefined && value !== false);
  return styled ? <Button {...props} {...look} {...state} /> : <button {...props} {...state} />;
}

/** `CommandButton` drawn as an `IconButton`. */
export function CommandIconButton({ command, disabled, onClick, ...props }: IconButtonProps & { command: AppCommand }) {
  return <IconButton {...props} {...useCommandState(command, disabled, onClick)} />;
}

/** A group that offers one operation, such as a setting picker, disappears when its host lacks it. */
export function CommandGate({ command, children }: { command: AppCommand; children: ReactNode }) {
  return useCommandControls().available(command) ? children : null;
}

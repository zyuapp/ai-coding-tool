import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Button, type ButtonProps, type ButtonVariant } from "./Button";

export type ConfirmActionProps = Omit<ButtonProps, "onClick" | "type" | "ref"> & {
  /** The destructive button the first press reveals, beside Cancel. It keeps the first button's `aria-label`, which names what it acts on. */
  confirm: string;
  onConfirm: () => void;
};

const QUIET_CANCEL: readonly ButtonVariant[] = ["secondary", "soft", "ghost", "link"];

/**
 * A button that asks once more before it acts. The first press swaps it for the destructive button
 * and Cancel, with the focus on Cancel; any answer, or Esc, puts the first button back and focuses it.
 * Moving the focus anywhere else takes the question back too, leaving the focus where it went.
 */
export function ConfirmAction({ confirm, onConfirm, children, ...trigger }: ConfirmActionProps) {
  const [confirming, setConfirming] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const danger = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  const answered = useRef(false);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (asked.current) first.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  const answer = () => {
    answered.current = true;
    setConfirming(false);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    answer();
  };
  const leave = (event: FocusEvent) => {
    if (answered.current || event.relatedTarget === cancel.current || event.relatedTarget === danger.current) return;
    asked.current = false;
    setConfirming(false);
  };
  if (!confirming) return <Button ref={first} {...trigger} onClick={() => { answered.current = false; setConfirming(true); }}>{children}</Button>;
  const { size, pill } = trigger;
  const variant = trigger.variant && QUIET_CANCEL.includes(trigger.variant) ? trigger.variant : "secondary";
  return (
    <>
      <Button ref={danger} className="danger armed" variant="danger" armed size={size} pill={pill} aria-label={trigger["aria-label"]} onKeyDown={escape} onBlur={leave} onClick={() => {
        answer();
        onConfirm();
      }}>{confirm}</Button>
      <Button ref={cancel} variant={variant} size={size} pill={pill} onKeyDown={escape} onBlur={leave} onClick={answer}>Cancel</Button>
    </>
  );
}

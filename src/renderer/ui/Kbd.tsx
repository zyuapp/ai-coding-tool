import type { ComponentPropsWithRef } from "react";
import "./kbd.css";

export type KbdProps = Omit<ComponentPropsWithRef<"kbd">, "children"> & {
  /** The keys in the order they are held, as they should read. */
  keys: readonly string[];
  /** A cap per key, or the keys run together as one chip inside a line of text. */
  size?: "cap" | "inline";
};

/** A keystroke. Inline, the keys are written as given with nothing between them. */
export function Kbd({ keys, size = "cap", className, ...rest }: KbdProps) {
  return (
    <kbd {...rest} className={className ? `kbd ${className}` : "kbd"} data-size={size}>
      {size === "cap" ? keys.map((key, index) => <span className="kbd-key" key={index}>{key}</span>) : keys.join("")}
    </kbd>
  );
}

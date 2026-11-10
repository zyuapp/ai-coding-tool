import type { ComponentPropsWithRef, ElementType } from "react";
import "./tone.css";
import "./chip.css";

export type ChipVariant = "count" | "tag" | "link" | "capsule";
export type ChipTone = "accent" | "danger" | "info" | "success" | "warning";

export type ChipProps<T extends ElementType = "span"> = {
  variant: ChipVariant;
  tone?: ChipTone;
  /** The element drawn: a span by default, an anchor for a link. */
  as?: T;
  className?: string;
} & Omit<ComponentPropsWithRef<T>, "as" | "variant" | "tone" | "className">;

/** A small label: a count, a tag, an in-line link, or a status capsule. */
export function Chip<T extends ElementType = "span">({ variant, tone, as, className, ...rest }: ChipProps<T>) {
  const Tag: ElementType = as ?? (variant === "link" ? "a" : "span");
  return <Tag {...rest} className={className ? `chip ${className}` : "chip"} data-variant={variant} data-tone={tone} />;
}

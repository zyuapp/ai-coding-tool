import type { ComponentPropsWithRef, ElementType } from "react";
import "./glass.css";

export type SurfaceKind = "popover" | "float" | "overlay" | "capsule" | "chip" | "strip";
export type SurfaceTone = "accent" | "danger" | "info" | "warning";

export type SurfaceProps<T extends ElementType = "div"> = {
  as?: T;
  kind: SurfaceKind;
  tone?: SurfaceTone;
  className?: string;
} & Omit<ComponentPropsWithRef<T>, "as" | "kind" | "tone" | "className">;

/** A pane of glass of the given kind, drawn as `as` (a div by default). */
export function Surface<T extends ElementType = "div">({ as, kind, tone, className, ...rest }: SurfaceProps<T>) {
  const Tag: ElementType = as ?? "div";
  return <Tag {...rest} className={className ? `glass-${kind} ${className}` : `glass-${kind}`} data-tone={tone} />;
}

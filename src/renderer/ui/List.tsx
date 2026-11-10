import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";
import { Chip, type ChipTone } from "./Chip";
import "./list.css";

const joined = (base: string, extra: string | undefined) => (extra ? `${base} ${extra}` : base);

/** A string that may be cut short carries itself as the tip that shows only while it is. */
const overflowTip = (text: ReactNode) => (typeof text === "string" ? { "data-tip": text, "data-tip-overflow": "" } : {});

type ListRowOwn = {
  /** A mark in the row's 24px lead column, such as a status orb. */
  leading?: ReactNode;
  title: ReactNode;
  /** A quieter second line under the title. */
  detail?: ReactNode;
  /** An id for the detail line, for the row or its neighbours to be described by. */
  detailId?: string;
  /** Marks or controls at the trailing edge. */
  trailing?: ReactNode;
  selected?: boolean;
  /** Sets the title in the body weight, for a list of plain links such as recent threads. */
  plain?: boolean;
  className?: string;
};

type ListRowAs<T extends "button" | "div" | "a"> = ListRowOwn & Omit<ComponentPropsWithRef<T>, keyof ListRowOwn | "children">;

export type ListRowProps =
  | ({ as?: "button" } & ListRowAs<"button">)
  | ({ as: "div" } & ListRowAs<"div">)
  | ({ as: "a" } & ListRowAs<"a">);

/** One row of a list: a lead mark, a title over its detail, and trailing marks. A button by default. */
export function ListRow({ as = "button", leading, title, detail, detailId, trailing, selected, plain, className, ...rest }: ListRowProps) {
  const Tag = as as ElementType;
  return (
    <Tag {...(as === "button" ? { type: "button" } : {})} {...rest} className={joined("list-row", className)} data-selected={selected || undefined} data-plain={plain || undefined}>
      {leading !== undefined && <span className="list-row-lead">{leading}</span>}
      <span className="list-row-text">
        <strong {...overflowTip(title)}>{title}</strong>
        {detail !== undefined && <small id={detailId} {...overflowTip(detail)}>{detail}</small>}
      </span>
      {trailing !== undefined && <span className="list-row-trail">{trailing}</span>}
    </Tag>
  );
}

export type ListHeadingProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  label: ReactNode;
  /** How many rows the list holds, as a count chip beside the label. */
  count?: ReactNode;
  /** Tints the count chip, for a list that asks for the user. */
  countTone?: ChipTone;
  /** Given `onToggle`, the label is a button that folds the list, with a chevron saying which way it is. */
  open?: boolean;
  onToggle?: () => void;
  /** The fold button's tip. */
  tip?: string;
  /** The id of the list the fold button shows and hides. */
  controls?: string;
  /** Beside the label, never inside it: what else the heading does or says. */
  action?: ReactNode;
  /** Stays at the top of its scroller, on a strip of glass while rows pass under it. */
  sticky?: boolean;
};

/** The label over a list: its count, its fold, and at most one action. */
export function ListHeading({ label, count, countTone, open, onToggle, tip, controls, action, sticky, className, ...rest }: ListHeadingProps) {
  const content = (
    <>
      <span className="list-heading-text">{label}</span>
      {count !== undefined && <Chip variant="count" tone={countTone}>{count}</Chip>}
      {onToggle && <span className="list-heading-chevron" aria-hidden="true" />}
    </>
  );
  return (
    <div {...rest} className={joined("list-heading", className)} data-sticky={sticky || undefined}>
      {onToggle
        ? <button type="button" className="list-heading-label" aria-expanded={open} aria-controls={controls} data-tip={tip} onClick={onToggle}>{content}</button>
        : <span className="list-heading-label">{content}</span>}
      {action !== undefined && <span className="list-heading-action">{action}</span>}
    </div>
  );
}

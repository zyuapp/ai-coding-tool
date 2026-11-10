import { useRef, type ComponentPropsWithRef, type ElementType, type KeyboardEvent, type ReactNode } from "react";
import "./button.css";

export type ButtonVariant = "primary" | "inverse" | "secondary" | "soft" | "danger" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

/** How a button looks, apart from its DOM props. */
export type ButtonLook = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pill?: boolean;
  /** A leading icon. Given with no children, the button is a square around it. */
  icon?: ReactNode;
  /** Swaps the label for a spinner, keeping the button's width. */
  busy?: boolean;
  /** Danger's second ask: the destructive answer, filled. */
  armed?: boolean;
  /** The fill a primary button takes. */
  tone?: "accent" | "info";
};

export type ButtonProps = ComponentPropsWithRef<"button"> & ButtonLook;

const joined = (base: string, extra: string | undefined) => (extra ? `${base} ${extra}` : base);

export function Button({ variant = "secondary", size = "md", pill, icon, busy, armed, tone, className, type = "button", children, ...rest }: ButtonProps) {
  const iconOnly = icon != null && (children == null || children === false);
  return (
    <button
      {...rest}
      type={type}
      className={joined("btn", className)}
      data-variant={variant}
      data-size={size}
      data-pill={pill || undefined}
      data-armed={armed || undefined}
      data-tone={tone}
      data-icon-only={iconOnly || undefined}
      aria-busy={busy || rest["aria-busy"]}
    >
      {busy
        ? <><span className="btn-busy-label">{icon}{children}</span><span className="btn-spinner" aria-hidden="true" /></>
        : <>{icon}{children}</>}
    </button>
  );
}

export type ButtonLinkProps<T extends ElementType = "a"> = Pick<ButtonLook, "variant" | "size" | "pill" | "icon" | "tone"> & {
  /** The anchor drawn: a plain `<a>` by default, or a component that renders one. */
  as?: T;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithRef<T>, "as" | "variant" | "size" | "pill" | "icon" | "tone" | "className" | "children">;

/** A link that looks like a `Button`. */
export function ButtonLink<T extends ElementType = "a">({ as, variant = "secondary", size = "md", pill, icon, tone, className, children, ...rest }: ButtonLinkProps<T>) {
  const Tag: ElementType = as ?? "a";
  const iconOnly = icon != null && (children == null || children === false);
  return (
    <Tag
      {...rest}
      className={joined("btn", className)}
      data-variant={variant}
      data-size={size}
      data-pill={pill || undefined}
      data-tone={tone}
      data-icon-only={iconOnly || undefined}
    >
      {icon}{children}
    </Tag>
  );
}

export type IconButtonProps = ComponentPropsWithRef<"button"> & {
  /** The button's accessible name, and its tooltip unless `tip` says otherwise. */
  label: string;
  tip?: string | false;
  variant?: "ghost" | "soft" | "glass" | "inverse" | "danger";
  size?: "xs" | "sm" | "md" | "lg";
  round?: boolean;
  pressed?: boolean;
  children: ReactNode;
};

export function IconButton({ label, tip, variant = "ghost", size = "sm", round, pressed, className, type = "button", children, ...rest }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      data-tip={tip === false ? undefined : (tip ?? label)}
      {...rest}
      type={type}
      className={joined("icon-btn", className)}
      data-variant={variant}
      data-size={size}
      data-round={round || undefined}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

export type ToggleButtonProps = Omit<ButtonProps, "variant" | "tone"> & { pressed: boolean; tone?: "accent" | "neutral" };

/** A button that stays down while what it turns on is on. */
export function ToggleButton({ pressed, tone = "neutral", ...rest }: ToggleButtonProps) {
  return <Button {...rest} variant="ghost" aria-pressed={pressed} data-toggle={tone} />;
}

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; tip?: string; tone?: string };

export type SegmentedProps<T extends string> = {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** A recessed track with a raised thumb, or a row of separate pills. */
  variant?: "track" | "pills";
  className?: string;
};

const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

/** One choice of a few, as radios: only the chosen one takes Tab, and the arrows move the choice. */
export function Segmented<T extends string>({ label, options, value, onChange, variant = "track", className }: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const focusable = options.some((option) => option.value === value) ? value : options[0]?.value;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[event.key];
    if (step === undefined) return;
    const radios = [...(group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? [])];
    /** The arrows move from the radio that has the keyboard, which is the chosen one unless a choice was refused. */
    const focused = radios.indexOf(document.activeElement as HTMLButtonElement);
    const at = focused !== -1 ? focused : options.findIndex((option) => option.value === value);
    const next = options[(Math.max(at, 0) + step + options.length) % options.length];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    radios[options.indexOf(next)]?.focus();
  };
  return (
    <div ref={group} className={joined("segmented", className)} data-variant={variant} role="radiogroup" aria-label={label} onKeyDown={move}>
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className={chosen ? "chosen" : undefined}
            aria-checked={chosen}
            tabIndex={option.value === focusable ? 0 : -1}
            data-tip={option.tip}
            data-tone={option.tone}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

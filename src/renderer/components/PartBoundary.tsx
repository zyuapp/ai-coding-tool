import { Component, createRef, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { LuCircleAlert as CircleAlert } from "react-icons/lu";
import { copyText } from "../clipboard";
import { firstFocusable } from "../focus";

type PartBoundaryProps = {
  /** What the part is called where its failure is logged. */
  name: string;
  /** The classes the part itself takes, so what stands in for it takes its place in the layout. */
  className?: string;
  /** What the part shows, such as the thread on screen. A failure is let go once it moves on, since the next one may draw. */
  resetKey?: string;
  children?: ReactNode;
};

/** How long the result of a copy stands in for the button's label. */
const COPIED_MS = 1400;

function CopyError({ text }: { text: string }) {
  const [result, setResult] = useState<"Copied" | "Copy failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return (
    <button type="button" className="part-fallback-copy" onClick={() => {
      void copyText(text).then((copied) => {
        setResult(copied ? "Copied" : "Copy failed");
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setResult(null), COPIED_MS);
      });
    }}>{result ?? "Copy error"}</button>
  );
}

/**
 * One part of the window that fails to draw says so in its own place, with a way to try again,
 * rather than taking the rest of the window with it. The failure is logged once, as it happens. A
 * retry that draws hands the keyboard to the part's first control.
 */
export class PartBoundary extends Component<PartBoundaryProps, { failed: boolean; error: string }> {
  state = { failed: false, error: "" };

  private readonly fallback = createRef<HTMLDivElement>();

  /** Where the fallback stood when Try again was pressed, which is where the part draws again. */
  private retried: { parent: Element; before: Element | null } | null = null;

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error: error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`The ${this.props.name} could not be shown.`, error, info.componentStack);
  }

  componentDidUpdate(previous: PartBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
      return;
    }
    const retried = this.retried;
    if (!retried || this.state.failed) return;
    this.retried = null;
    const drawn = retried.before ? retried.before.nextElementSibling : retried.parent.firstElementChild;
    if (drawn instanceof HTMLElement) firstFocusable(drawn)?.focus();
  }

  private readonly retry = () => {
    const node = this.fallback.current;
    this.retried = node?.parentElement ? { parent: node.parentElement, before: node.previousElementSibling } : null;
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div ref={this.fallback} className={this.props.className}>
        <div className="part-fallback" role="status">
          <p><CircleAlert size={16} aria-hidden="true" />This part couldn’t be shown.</p>
          <button type="button" onClick={this.retry}>Try again</button>
          {this.state.error && <CopyError text={`The ${this.props.name} could not be shown.\n${this.state.error}`} />}
        </div>
      </div>
    );
  }
}

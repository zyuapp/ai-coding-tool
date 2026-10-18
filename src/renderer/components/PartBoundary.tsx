import { Component, type ErrorInfo, type ReactNode } from "react";

type PartBoundaryProps = {
  /** What the part is called where its failure is logged. */
  name: string;
  /** The classes the part itself takes, so what stands in for it takes its place in the layout. */
  className?: string;
  children?: ReactNode;
};

/**
 * One part of the window that fails to draw says so in its own place, with a way to try again,
 * rather than taking the rest of the window with it. The failure is logged once, as it happens.
 */
export class PartBoundary extends Component<PartBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`The ${this.props.name} could not be shown.`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={`part-fallback ${this.props.className ?? ""}`} role="status">
        <p>This part couldn’t be shown.</p>
        <button type="button" onClick={() => this.setState({ failed: false })}>Try again</button>
      </div>
    );
  }
}

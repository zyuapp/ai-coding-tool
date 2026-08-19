import { useEffect, useId, useRef, useState } from "react";

let initialized = false;

export function MermaidBlock({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const id = useId().replaceAll(":", "");
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ source: string; svg?: string; error?: string }>({ source });

  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void import("mermaid").then(async ({ default: mermaid }) => {
      if (!initialized) {
        const scheme = getComputedStyle(document.documentElement).colorScheme;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: scheme === "light" ? "default" : "dark",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        });
        initialized = true;
      }
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, source);
        if (!cancelled) setResult({ source, svg });
      } catch (error) {
        if (!cancelled) setResult({ source, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return () => { cancelled = true; };
  }, [id, source, visible]);

  const current = result.source === source ? result : { source };
  return (
    <div className="mermaid-block" ref={host}>
      {!visible || (!current.svg && !current.error) ? <span className="mermaid-loading">Rendering diagram…</span> : null}
      {current.svg ? <div className="mermaid-svg" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: current.svg }} /> : null}
      {current.error ? <details className="mermaid-error"><summary>Diagram could not be rendered</summary><pre><code>{source}</code></pre></details> : null}
    </div>
  );
}

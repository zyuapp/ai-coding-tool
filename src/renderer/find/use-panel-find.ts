/**
 * The one searcher every small panel shares. A panel draws everything it has, so what it drew is what
 * there is to find: there is no row data behind it the way a transcript or a review has one.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { FindView } from "../../application/workspace-state";
import { MAX_FIND_HITS, targetKey, type FindResults } from "../../domain/find";
import { drawnMatches, paintMatches } from "./paint";

/**
 * Searches a panel over the text it has drawn: lights every match with the same highlights the
 * transcript uses, keeps the one being read in view, and reports how many it found. The panel keeps
 * no place of its own — the bar's place is the reducer's — so this only ever finds and paints.
 */
export function usePanelFind({ root, find, onResults }: {
  root: RefObject<HTMLElement | null>;
  find: FindView | null;
  onResults: (results: FindResults) => void;
}): void {
  /** Held rather than depended on, so a parent that rebuilds its callbacks cannot start a report loop. */
  const report = useRef(onResults);
  report.current = onResults;
  /**
   * The last count this panel gave, under the needle it counted. Stepping through what was found says
   * nothing new, but a fresh needle always does: the reducer throws the old count away the moment the
   * query changes, so a new query that happens to find as many as the last one must still say so.
   */
  const reported = useRef<{ needle: string; matches: number } | null>(null);
  /** Bumped when the panel redraws under an open search: a subagent finishing, a step turning green. */
  const [redrawn, setRedrawn] = useState(0);

  const needle = find?.query.trim().toLowerCase() ?? "";
  const painter = find ? targetKey(find.target) : "";
  const index = find?.index ?? 0;

  useEffect(() => {
    const element = root.current;
    if (!needle || !element) return;
    let frame = 0;
    /** The highlight registry writes no DOM, so the observer can never see its own painting. */
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(() => { frame = 0; setRedrawn((count) => count + 1); });
    });
    observer.observe(element, { subtree: true, childList: true, characterData: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [root, needle, painter]);

  useEffect(() => {
    /** A panel nobody is searching is never asked what it found, and has nothing lit to clear. */
    if (!painter) return;
    /** DOM order is the order the panel draws in, so the match being read is simply the nth one. */
    const found = drawnMatches(root.current, needle, "", MAX_FIND_HITS);
    const active = found[index]?.range ?? null;
    paintMatches(painter, found.map((match) => match.range), active);
    active?.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
    if (reported.current?.needle === needle && reported.current.matches === found.length) return;
    reported.current = { needle, matches: found.length };
    report.current({ matches: found.length });
  }, [root, painter, needle, index, redrawn]);

  useEffect(() => () => { reported.current = null; paintMatches(painter, [], null); }, [painter]);
}

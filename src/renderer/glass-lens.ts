/**
 * Panes whose rims bend what is behind them. Each ends its backdrop filter in var(--glass-lens),
 * which points at an SVG displacement filter cut to the pane's size and corners.
 */
const LENSED = [
  ".glass-popover:not(.menu-submenu)",
  ".glass-float",
  ".glass-overlay",
  ".glass-capsule",
  ".glass-pane",
  ".icon-btn[data-variant='glass']",
  ".drop-hint",
  ".annotator-label",
].join(", ");

/** How far a rim bends what is behind it, as a share of the most it can without folding the image over. */
const BEND = 0.3;
/** Maps are drawn at this share of the pane's size; the displacement is smooth, so scaling them up shows no steps. */
const MAP_SCALE = 0.5;
const SVG = "http://www.w3.org/2000/svg";
/** A pane still changing size goes unbent until it has held one size this long. */
const SETTLE_MS = 150;

export type LensShape = { width: number; height: number; radius: number };

/** The band along the rim that bends, in CSS pixels. */
export function lensBezel({ height, radius }: LensShape) {
  return Math.min(Math.max(16, radius), 24, height / 2);
}

/**
 * An RGBA displacement map `columns` by `rows` over a rounded rectangle. Red and green carry the
 * x and y offset around 128: inside the bezel each pixel samples inward along the rim's normal,
 * hardest at the rim; past it the map is neutral.
 */
export function lensMap(shape: LensShape, columns: number, rows: number) {
  const { width, height } = shape;
  const radius = Math.min(shape.radius, width / 2, height / 2);
  const bezel = lensBezel(shape);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const map = new Uint8ClampedArray(columns * rows * 4);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = ((column + 0.5) / columns) * width - halfWidth;
      const y = ((row + 0.5) / rows) * height - halfHeight;
      const overX = Math.abs(x) - (halfWidth - radius);
      const overY = Math.abs(y) - (halfHeight - radius);
      let normalX = 0;
      let normalY = 0;
      let depth: number;
      if (overX > 0 && overY > 0) {
        const length = Math.hypot(overX, overY) || 1;
        depth = radius - length;
        normalX = (Math.sign(x) * overX) / length;
        normalY = (Math.sign(y) * overY) / length;
      } else if (overX > overY) {
        depth = halfWidth - Math.abs(x);
        normalX = Math.sign(x);
      } else {
        depth = halfHeight - Math.abs(y);
        normalY = Math.sign(y);
      }
      const pull = depth >= 0 && depth < bezel ? (1 - depth / bezel) ** 2 : 0;
      const at = (row * columns + column) * 4;
      map[at] = 128 - normalX * pull * 127;
      map[at + 1] = 128 - normalY * pull * 127;
      map[at + 2] = 128;
      map[at + 3] = 255;
    }
  }
  return map;
}

function lensFilter(id: string, shape: LensShape) {
  const columns = Math.max(1, Math.ceil(shape.width * MAP_SCALE));
  const rows = Math.max(1, Math.ceil(shape.height * MAP_SCALE));
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  canvas.getContext("2d")!.putImageData(new ImageData(lensMap(shape, columns, rows), columns, rows), 0, 0);
  const filter = document.createElementNS(SVG, "filter");
  const bounds = { x: "0", y: "0", width: String(shape.width), height: String(shape.height) };
  for (const [name, value] of Object.entries({ id, ...bounds, filterUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" })) filter.setAttribute(name, value);
  const image = document.createElementNS(SVG, "feImage");
  for (const [name, value] of Object.entries({ ...bounds, href: canvas.toDataURL(), preserveAspectRatio: "none", result: "map" })) image.setAttribute(name, value);
  const displace = document.createElementNS(SVG, "feDisplacementMap");
  /** The filter moves a pixel by scale × (channel − ½), and the map's channels reach ½ ± ½. */
  const scale = 2 * BEND * 0.48 * lensBezel(shape);
  for (const [name, value] of Object.entries({ in: "SourceGraphic", in2: "map", scale: String(scale), xChannelSelector: "R", yChannelSelector: "G" })) displace.setAttribute(name, value);
  filter.append(image, displace);
  return filter;
}

function cornerRadius(pane: HTMLElement, width: number, height: number) {
  const corner = getComputedStyle(pane).borderTopLeftRadius;
  const amount = Number.parseFloat(corner) || 0;
  const radius = corner.endsWith("%") ? (amount / 100) * Math.min(width, height) : amount;
  return Math.min(radius, width / 2, height / 2);
}

/** Keeps every lensed pane pointed at a filter of its own size; panes of one size share a filter. */
export function installGlassLens() {
  if (matchMedia("(prefers-reduced-transparency: reduce)").matches) return () => {};
  const defs = document.createElementNS(SVG, "svg");
  defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  defs.style.position = "absolute";
  document.body.append(defs);
  const filters = new Map<string, { node: SVGFilterElement; users: number }>();
  const panes = new Map<HTMLElement, string | null>();
  let made = 0;

  const release = (pane: HTMLElement) => {
    const key = panes.get(pane);
    panes.set(pane, null);
    pane.style.removeProperty("--glass-lens");
    const filter = key ? filters.get(key) : undefined;
    if (!filter || --filter.users > 0) return;
    filter.node.remove();
    filters.delete(key!);
  };
  const fit = (pane: HTMLElement, rawWidth: number, rawHeight: number) => {
    const width = Math.round(rawWidth);
    const height = Math.round(rawHeight);
    if (width < 8 || height < 8) return release(pane);
    const radius = Math.round(cornerRadius(pane, width, height));
    const key = `${width}x${height}r${radius}`;
    if (panes.get(pane) === key) return;
    release(pane);
    let filter = filters.get(key);
    if (!filter) {
      filter = { node: lensFilter(`glass-lens-${made++}`, { width, height, radius }), users: 0 };
      defs.append(filter.node);
      filters.set(key, filter);
    }
    filter.users++;
    panes.set(pane, key);
    pane.style.setProperty("--glass-lens", `url(#${filter.node.id})`);
  };
  const settling = new Map<HTMLElement, number>();
  const stopSettling = (pane: HTMLElement) => {
    clearTimeout(settling.get(pane));
    settling.delete(pane);
  };
  /** A pane's first size is cut at once; while it keeps resizing, cutting a map per frame would stall a drag. */
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const pane = entry.target as HTMLElement;
      const box = entry.borderBoxSize[0];
      if (!box || !panes.has(pane)) continue;
      const { inlineSize, blockSize } = box;
      if (panes.get(pane) === null && !settling.has(pane)) {
        fit(pane, inlineSize, blockSize);
        continue;
      }
      if (panes.get(pane)) release(pane);
      stopSettling(pane);
      settling.set(pane, window.setTimeout(() => {
        settling.delete(pane);
        if (panes.has(pane)) fit(pane, inlineSize, blockSize);
      }, SETTLE_MS));
    }
  });
  const track = (pane: HTMLElement) => {
    if (panes.has(pane)) return;
    panes.set(pane, null);
    sizes.observe(pane, { box: "border-box" });
  };
  const untrack = (pane: HTMLElement) => {
    stopSettling(pane);
    release(pane);
    panes.delete(pane);
    sizes.unobserve(pane);
  };
  const scan = (root: Element) => {
    if (root instanceof HTMLElement && root.matches(LENSED)) track(root);
    for (const pane of root.querySelectorAll<HTMLElement>(LENSED)) track(pane);
  };
  const changes = new MutationObserver((records) => {
    let removed = false;
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target as HTMLElement;
        if (target.matches(LENSED)) track(target);
        else if (panes.has(target)) untrack(target);
        continue;
      }
      for (const node of record.addedNodes) if (node instanceof Element) scan(node);
      if (record.removedNodes.length) removed = true;
    }
    if (removed) for (const pane of panes.keys()) if (!pane.isConnected) untrack(pane);
  });
  scan(document.body);
  changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "data-variant"] });
  return () => {
    changes.disconnect();
    sizes.disconnect();
    for (const pane of settling.keys()) stopSettling(pane);
    for (const pane of panes.keys()) pane.style.removeProperty("--glass-lens");
    panes.clear();
    filters.clear();
    defs.remove();
  };
}

export type AnnotationKind = "box" | "arrow";

/**
 * Geometry is normalized to 0..1 of the image so it survives resizing and exports at native resolution.
 * A box spans (x, y) to (x + width, y + height) with non-negative extents; an arrow runs from its tail at
 * (x, y) to its tip at (x + width, y + height), so its extents are signed.
 */
export type Annotation = { kind: AnnotationKind; x: number; y: number; width: number; height: number; text: string };

export type Point = { x: number; y: number };

/** The image as it is drawn on screen, which is what a pointer's position is measured against. */
export type Frame = { width: number; height: number };

const MARK_COLOR = "#ff453a";
export const MIN_SIZE = 0.012;
export const MIN_LENGTH = 0.03;

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function normalizeRect(start: Point, end: Point): Omit<Annotation, "kind" | "text"> {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function arrowBetween(start: Point, end: Point): Omit<Annotation, "kind" | "text"> {
  return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
}

function distanceToSegment(point: Point, from: Point, to: Point) {
  const runX = to.x - from.x;
  const runY = to.y - from.y;
  const span = runX * runX + runY * runY;
  const along = span === 0 ? 0 : Math.min(1, Math.max(0, ((point.x - from.x) * runX + (point.y - from.y) * runY) / span));
  return Math.hypot(point.x - (from.x + runX * along), point.y - (from.y + runY * along));
}

/** Where a pointer is over the drawn image, as a share of it. */
export function pointAt(event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) };
}

/** Corners in on-screen pixels: a box spans them, an arrow runs tail-to-tip along them. */
export function cornersOf(shape: Annotation, frame: Frame) {
  return {
    from: { x: shape.x * frame.width, y: shape.y * frame.height },
    to: { x: (shape.x + shape.width) * frame.width, y: (shape.y + shape.height) * frame.height },
  };
}

/** The mark under a point, latest first, so what is drawn on top is what answers. */
export function markAt(shapes: Annotation[], point: Point, frame: Frame) {
  const at = { x: point.x * frame.width, y: point.y * frame.height };
  const tolerance = 9;
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const { from, to } = cornersOf(shapes[index], frame);
    if (shapes[index].kind === "arrow") {
      if (distanceToSegment(at, from, to) <= tolerance) return index;
      continue;
    }
    const inside = at.x >= from.x - tolerance && at.x <= to.x + tolerance && at.y >= from.y - tolerance && at.y <= to.y + tolerance;
    if (inside) return index;
  }
  return null;
}

function drawArrow(context: CanvasRenderingContext2D, annotation: Annotation, width: number, height: number, stroke: number) {
  const tailX = annotation.x * width;
  const tailY = annotation.y * height;
  const tipX = (annotation.x + annotation.width) * width;
  const tipY = (annotation.y + annotation.height) * height;
  const angle = Math.atan2(tipY - tailY, tipX - tailX);
  const length = Math.hypot(tipX - tailX, tipY - tailY);
  const head = Math.max(Math.min(length * 0.3, stroke * 9), stroke * 4);
  const baseX = tipX - Math.cos(angle) * head;
  const baseY = tipY - Math.sin(angle) * head;
  const spread = head * 0.5;
  context.lineWidth = stroke;
  context.lineCap = "round";
  context.strokeStyle = MARK_COLOR;
  context.fillStyle = MARK_COLOR;
  context.beginPath();
  context.moveTo(tailX, tailY);
  context.lineTo(baseX, baseY);
  context.stroke();
  context.beginPath();
  context.moveTo(tipX, tipY);
  context.lineTo(baseX - Math.sin(angle) * spread, baseY + Math.cos(angle) * spread);
  context.lineTo(baseX + Math.sin(angle) * spread, baseY - Math.cos(angle) * spread);
  context.closePath();
  context.fill();
}

const BADGE_INK = "#ffffff";

type Rect = { x: number; y: number; width: number; height: number };

export function badgeRadius(width: number, height: number) {
  return Math.max(11, Math.round(Math.max(width, height) * 0.013));
}

/** Corners first, outside then inside, so a badge leaves the marked area clear whenever it can. */
function spotsAround(box: Rect, radius: number) {
  const { x, y, width, height } = box;
  return [
    { x: x - radius, y: y - radius },
    { x: x + width + radius, y: y - radius },
    { x: x - radius, y: y + height + radius },
    { x: x + width + radius, y: y + height + radius },
    { x: x + radius, y: y + radius },
    { x: x + width - radius, y: y + radius },
    { x: x + radius, y: y + height - radius },
    { x: x + width - radius, y: y + height - radius },
  ];
}

/**
 * Where each box's badge sits, in image pixels. Boxes drawn close together would stack their badges
 * on the same corner, so each one takes the first spot no earlier badge already holds.
 */
export function placeBadges(boxes: Rect[], width: number, height: number) {
  const radius = badgeRadius(width, height);
  const placed: Point[] = [];
  boxes.forEach((box) => {
    const spots = spotsAround(box, radius).map((spot) => ({
      x: Math.min(Math.max(spot.x, radius), Math.max(width - radius, radius)),
      y: Math.min(Math.max(spot.y, radius), Math.max(height - radius, radius)),
    }));
    const free = spots.find((spot) => placed.every((taken) => Math.hypot(spot.x - taken.x, spot.y - taken.y) >= radius * 2));
    placed.push(free ?? spots[0]);
  });
  return placed;
}

function drawBadge(context: CanvasRenderingContext2D, center: Point, radius: number, mark: string) {
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fillStyle = MARK_COLOR;
  context.fill();
  context.lineWidth = Math.max(1, radius * 0.14);
  context.strokeStyle = BADGE_INK;
  context.stroke();
  context.fillStyle = BADGE_INK;
  context.fillText(mark, center.x, center.y);
}

/**
 * Marks carry their number and nothing else: the notes travel with the prompt as text, so drawing
 * them again would only cover the screenshot they describe.
 */
export function drawAnnotations(context: CanvasRenderingContext2D, annotations: Annotation[], width: number, height: number, prefix = "") {
  const stroke = Math.max(2, Math.round(Math.max(width, height) * 0.003));
  const radius = badgeRadius(width, height);
  const boxes = annotations.filter((annotation) => annotation.kind === "box").map((annotation) => ({
    x: annotation.x * width,
    y: annotation.y * height,
    width: Math.max(annotation.width * width, stroke),
    height: Math.max(annotation.height * height, stroke),
  }));
  const centers = placeBadges(boxes, width, height);
  context.lineJoin = "round";
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.font = `700 ${Math.round(radius * 1.1)}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`;
  // Only boxes are numbered, so arrows never shift the marks the prompt refers to.
  let mark = 0;
  annotations.forEach((annotation) => {
    if (annotation.kind === "arrow") {
      drawArrow(context, annotation, width, height, stroke);
      return;
    }
    const box = boxes[mark];
    const center = centers[mark];
    mark += 1;
    context.lineWidth = stroke;
    context.strokeStyle = MARK_COLOR;
    context.strokeRect(box.x + stroke / 2, box.y + stroke / 2, Math.max(box.width - stroke, 1), Math.max(box.height - stroke, 1));
    drawBadge(context, center, radius, `${prefix}${mark}`);
  });
}

export function renderAnnotated(image: HTMLImageElement, annotations: Annotation[], prefix = "") {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawAnnotations(context, annotations, canvas.width, canvas.height, prefix);
  return canvas.toDataURL("image/png");
}

/**
 * The same render from a data URL. A mark's letter follows the screenshot's place in the send, which
 * is only settled once the composer hands the images over, so the marks are drawn again there.
 */
export function renderAnnotatedSource(source: string, annotations: Annotation[], prefix = "") {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      try {
        resolve(renderAnnotated(image, annotations, prefix));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    image.addEventListener("error", () => reject(new Error("Could not read the image to annotate.")));
    image.src = source;
  });
}

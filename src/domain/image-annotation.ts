/** The marks a user draws on an image before sending it. */
export type ImageAnnotationKind = "box" | "arrow";

/**
 * Geometry is normalized to 0..1 of the image so it survives resizing and exports at native resolution.
 * A box spans (x, y) to (x + width, y + height) with non-negative extents; an arrow runs from its tail at
 * (x, y) to its tip at (x + width, y + height), so its extents are signed.
 */
export type ImageAnnotation = { kind: ImageAnnotationKind; x: number; y: number; width: number; height: number; text: string };

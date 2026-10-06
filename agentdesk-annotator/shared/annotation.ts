/* Wire types shared by the server and the extension. The zod schemas are the
 * single source; TypeScript types are inferred from them. */
import * as z from "zod";
import { ACTORS, CSS_PIXELS, DEFAULT_TAG, SCREENSHOT_MIMES, STATUSES, STYLE_PROPERTIES, TAGS } from "./vocab.ts";

export const Tag = z.enum(TAGS);
export const Status = z.enum(STATUSES);
export const Actor = z.enum(ACTORS);
export type Tag = z.infer<typeof Tag>;
export type Status = z.infer<typeof Status>;
export type Actor = z.infer<typeof Actor>;

export const BBox = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** Held to `CSS_PIXELS` so a style change carries no page text, and the brief can print it outside the page-text wrapper. */
const CssPixels = z.string().regex(CSS_PIXELS);

/** One property the reader changed on the element and saw on the page: the computed value before, and theirs. */
export const StyleChange = z.object({
  property: z.enum(STYLE_PROPERTIES),
  from: CssPixels,
  to: CssPixels,
});
export type StyleChange = z.infer<typeof StyleChange>;

/** What the picker records about the annotated container, or the element containing a dragged region. */
export const ElementMetadata = z.object({
  tagName: z.string().max(64).optional(),
  selector: z.string().max(2000).optional(),
  fullPath: z.string().max(2000).optional(),
  classes: z.string().max(500).optional(),
  text: z.string().max(500).optional(),
  component: z.string().max(500).optional(),
  bbox: BBox.optional(),
  /** A dragged region, in document CSS pixels. Absent when a whole element was picked. */
  region: BBox.optional(),
  styles: z.string().max(1000).optional(),
  /** Changes the reader previewed on the element before saving. Absent when nothing was changed. */
  styleChanges: z.array(StyleChange).max(STYLE_PROPERTIES.length).optional(),
});
export type ElementMetadata = z.infer<typeof ElementMetadata>;

export const CoverageItem = z.object({
  selector: z.string().max(2000),
  tag: z.string().max(64),
  text: z.string().max(500),
});
export const Coverage = z.object({
  scanned: z.number().int().nonnegative(),
  items: z.array(CoverageItem).max(200),
});
export type CoverageItem = z.infer<typeof CoverageItem>;
export type Coverage = z.infer<typeof Coverage>;

export const NewAnnotation = z.object({
  url: z.url().max(4000),
  title: z.string().max(500).default(""),
  text: z.string().trim().min(1).max(10000),
  tag: Tag.default(DEFAULT_TAG),
  metadata: ElementMetadata.default({}),
});
export type NewAnnotation = z.infer<typeof NewAnnotation>;

export const ReplyInput = z.object({ text: z.string().trim().min(1).max(10000) });

export const ScreenshotUpload = z.object({
  mime: z.enum(SCREENSHOT_MIMES),
  dataBase64: z.base64().max(8 * 1024 * 1024),
  coverage: Coverage,
});
export type ScreenshotUpload = z.infer<typeof ScreenshotUpload>;

export interface Reply {
  by: Actor;
  text: string;
  at: string;
}

export interface ScreenshotSummary {
  mime: string;
  createdAt: string;
  coverageCount: number;
}

export interface Annotation {
  id: number;
  status: Status;
  url: string;
  title: string;
  text: string;
  tag: Tag;
  metadata: ElementMetadata;
  replies: Reply[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: Actor | null;
  reopenedBy: Actor | null;
  screenshot: ScreenshotSummary | null;
}

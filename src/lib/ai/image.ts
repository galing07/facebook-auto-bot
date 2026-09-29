import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import twemoji from "@twemoji/api";
import sharp from "sharp";

import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/server";

import type {
  ImageSource,
  ImageSourcePref,
} from "@/lib/types";

/**
 * Facebook Auto Bot
 * ------------------------------------------------------------
 * Image pipeline:
 *
 * AI:
 *   Gemini 3.1 Flash Image
 *       ↓
 *   Sharp
 *       ↓
 *   Caption rendered with exact TTF fontfile
 *       ↓
 *   Supabase Storage
 *
 * STOCK:
 *   Pexels
 *       ↓
 *   Sharp
 *       ↓
 *   Caption rendered with exact TTF fontfile
 *       ↓
 *   Supabase Storage
 *
 * IMPORTANT:
 * ------------------------------------------------------------
 * Caption is NOT rendered using SVG <text>.
 *
 * Sharp's text renderer is used directly with:
 *
 *   fontfile: absolute path to DejaVuSans-Bold.ttf
 *
 * This prevents Windows/Vercel font fallback differences.
 * ------------------------------------------------------------
 */

const STORAGE_BUCKET = "post-images";

const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
const GEMINI_IMAGE_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const FINAL_WIDTH = 1080;
const FINAL_HEIGHT = 1080;

const GEMINI_TIMEOUT_MS = 90_000;
const PEXELS_TIMEOUT_MS = 20_000;

const FONT_FILE_NAME = "DejaVuSans-Bold.ttf";

/**
 * ------------------------------------------------------------
 * FONT
 * ------------------------------------------------------------
 *
 * Primary location:
 *
 *   <project-root>/fonts/DejaVuSans-Bold.ttf
 *
 * Additional fallbacks are included for local development.
 */

function findFontFile(): string | null {
  const candidates = [
    // Vercel / project root
    path.join(process.cwd(), "fonts", FONT_FILE_NAME),

    // Public folder fallback
    path.join(process.cwd(), "public", "fonts", FONT_FILE_NAME),

    // src/lib -> project root fallback
    path.join(process.cwd(), "..", "..", "fonts", FONT_FILE_NAME),

    // Linux system font
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",

    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",

    "/usr/local/share/fonts/DejaVuSans-Bold.ttf",
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);

        if (stat.isFile() && stat.size > 10_000) {
          return candidate;
        }
      }
    } catch {
      // Ignore inaccessible candidates.
    }
  }

  return null;
}

const FONT_FILE = findFontFile();

if (FONT_FILE) {
  console.log(`[image] Caption font: ${FONT_FILE}`);
} else {
  console.warn(
    `[image] WARNING: ${FONT_FILE_NAME} not found. ` +
      `Caption rendering will use system font fallback.`
  );
}

/**
 * ------------------------------------------------------------
 * TYPES
 * ------------------------------------------------------------
 */

interface GeminiImageResponse {
  output_image?: {
    data?: string;
    mime_type?: string;
  };

  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      image?: {
        data?: string;
        mime_type?: string;
      };
      data?: string;
      mime_type?: string;
    }>;
  }>;
}

interface PexelsPhoto {
  width?: number;
  height?: number;

  src?: {
    original?: string;
    large2x?: string;
    large?: string;
    medium?: string;
  };
}

interface PexelsResponse {
  photos?: PexelsPhoto[];
}

/**
 * ------------------------------------------------------------
 * CATEGORY DETECTION
 * ------------------------------------------------------------
 */

type VisualCategory =
  | "FOOD"
  | "TRAVEL"
  | "TECHNOLOGY"
  | "HEALTH"
  | "FASHION"
  | "SPORTS"
  | "NATURE"
  | "BUSINESS"
  | "GENERAL";

const CATEGORY_KEYWORDS: Record<
  Exclude<VisualCategory, "GENERAL">,
  string[]
> = {
  FOOD: [
    "restaurant",
    "cooking",
    "recipe",
    "cuisine",
    "food",
    "meal",
    "dinner",
    "lunch",
    "breakfast",
    "dessert",
    "cake",
    "coffee",
    "drink",
    "chef",
    "kitchen",
  ],

  TRAVEL: [
    "destination",
    "vacation",
    "holiday",
    "travel",
    "tourism",
    "beach",
    "mountain",
    "hotel",
    "island",
    "airport",
    "trip",
    "city",
  ],

  TECHNOLOGY: [
    "artificial intelligence",
    "machine learning",
    "smartphone",
    "computer",
    "technology",
    "software",
    "robot",
    "digital",
    "internet",
    "app",
    "coding",
    "programming",
    "ai",
  ],

  HEALTH: [
    "mental health",
    "health",
    "fitness",
    "exercise",
    "nutrition",
    "wellness",
    "doctor",
    "medical",
    "medicine",
    "sleep",
    "workout",
    "healthy",
  ],

  FASHION: [
    "fashion",
    "clothing",
    "outfit",
    "dress",
    "style",
    "beauty",
    "makeup",
    "skincare",
    "shoes",
    "jewelry",
    "model",
  ],

  SPORTS: [
    "football",
    "soccer",
    "basketball",
    "tennis",
    "baseball",
    "sports",
    "athlete",
    "running",
    "cycling",
    "gym",
    "match",
    "championship",
  ],

  NATURE: [
    "nature",
    "forest",
    "mountain",
    "ocean",
    "sea",
    "lake",
    "river",
    "wildlife",
    "animal",
    "garden",
    "sunset",
    "landscape",
  ],

  BUSINESS: [
    "business",
    "marketing",
    "startup",
    "entrepreneur",
    "finance",
    "money",
    "investment",
    "company",
    "office",
    "career",
    "work",
    "leadership",
  ],
};

function detectCategory(text: string): VisualCategory {
  const normalized = text.toLowerCase();

  let bestCategory: VisualCategory = "GENERAL";
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(
    CATEGORY_KEYWORDS
  )) {
    let score = 0;

    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        score += keyword.length >= 8 ? 2 : 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = category as VisualCategory;
    }
  }

  return bestCategory;
}

/**
 * ------------------------------------------------------------
 * FETCH WITH TIMEOUT
 * ------------------------------------------------------------
 */

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ------------------------------------------------------------
 * GEMINI IMAGE PROMPT
 * ------------------------------------------------------------
 */

function buildGeminiPrompt(
  prompt: string,
  title?: string
): string {
  const category = detectCategory(
    `${title ?? ""} ${prompt}`
  );

  return `
Create a photorealistic, premium social-media image for a Facebook post.

Topic:
${prompt}

${title ? `Headline context: ${title}` : ""}

Visual category:
${category}

Requirements:
- Square composition.
- 1:1 aspect ratio.
- Professional editorial photography.
- Strong visual hierarchy.
- High contrast.
- Natural realistic lighting.
- Clean composition.
- Subject should be immediately understandable.
- Suitable for a Facebook feed.
- Leave enough visual breathing room for a headline overlay.
- No text inside the generated image.
- No captions.
- No typography.
- No logos.
- No watermark.
- No fake UI.
- No letters.
- No numbers.
- No words.
- Do not create a poster.
- Do not create an advertisement containing text.

The headline will be rendered separately by the application.

Generate only the image.
`.trim();
}

/**
 * ------------------------------------------------------------
 * GEMINI IMAGE GENERATION
 * ------------------------------------------------------------
 */

async function generateWithGemini(
  prompt: string,
  title?: string
): Promise<Buffer> {
  const apiKey = env.geminiApiKey;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const finalPrompt = buildGeminiPrompt(prompt, title);

  const response = await fetchWithTimeout(
    GEMINI_IMAGE_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,

        input: [
          {
            type: "text",
            text: finalPrompt,
          },
        ],

        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "1:1",
          image_size: "1K",
        },
      }),
    },
    GEMINI_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini image generation failed (${response.status}): ${errorText.slice(
        0,
        1000
      )}`
    );
  }

  const data =
    (await response.json()) as GeminiImageResponse;

  /**
   * Format 1:
   *
   * output_image.data
   */
  const directImage = data.output_image?.data;

  if (directImage) {
    return Buffer.from(directImage, "base64");
  }

  /**
   * Format 2:
   *
   * steps[].content[].image.data
   */
  for (const step of data.steps ?? []) {
    for (const content of step.content ?? []) {
      if (content.image?.data) {
        return Buffer.from(
          content.image.data,
          "base64"
        );
      }

      if (
        content.type === "image" &&
        content.data
      ) {
        return Buffer.from(
          content.data,
          "base64"
        );
      }
    }
  }

  throw new Error(
    "Gemini returned successfully but no image data was found."
  );
}

/**
 * ------------------------------------------------------------
 * PEXELS QUERY
 * ------------------------------------------------------------
 */

function buildPexelsQuery(
  prompt: string,
  title?: string
): string {
  const category = detectCategory(
    `${title ?? ""} ${prompt}`
  );

  const categoryQueries: Record<
    VisualCategory,
    string
  > = {
    FOOD: "food cooking restaurant meal",
    TRAVEL: "travel destination landscape",
    TECHNOLOGY: "technology computer digital",
    HEALTH: "health wellness fitness",
    FASHION: "fashion lifestyle model",
    SPORTS: "sports athlete action",
    NATURE: "nature landscape outdoors",
    BUSINESS: "business office professional",
    GENERAL: "lifestyle professional editorial",
  };

  const cleaned = `${title ?? ""} ${prompt}`
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  /**
   * Keep query short.
   * Pexels works better with concise keywords.
   */
  const words = cleaned
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);

  return `${words.join(" ")} ${categoryQueries[category]}`
    .trim()
    .slice(0, 180);
}

/**
 * ------------------------------------------------------------
 * PEXELS IMAGE
 * ------------------------------------------------------------
 */

async function generateWithPexels(
  prompt: string,
  title?: string
): Promise<Buffer> {
  const apiKey = env.pexelsApiKey;

  if (!apiKey) {
    throw new Error("PEXELS_API_KEY is not configured.");
  }

  const query = buildPexelsQuery(
    prompt,
    title
  );

  const url =
    "https://api.pexels.com/v1/search?" +
    new URLSearchParams({
      query,
      orientation: "square",
      size: "large",
      per_page: "15",
    }).toString();

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Authorization: apiKey,
      },
    },
    PEXELS_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Pexels request failed (${response.status}): ${errorText.slice(
        0,
        500
      )}`
    );
  }

  const data =
    (await response.json()) as PexelsResponse;

  const photos = (data.photos ?? []).filter(
    (photo) =>
      Boolean(
        photo.src?.large2x ||
          photo.src?.large ||
          photo.src?.original
      )
  );

  if (!photos.length) {
    throw new Error(
      `Pexels returned no usable images for "${query}".`
    );
  }

  /**
   * Randomize result so repeated posts don't always
   * use the first Pexels image.
   */
  const photo =
    photos[
      Math.floor(Math.random() * photos.length)
    ];

  const imageUrl =
    photo.src?.large2x ??
    photo.src?.large ??
    photo.src?.original;

  if (!imageUrl) {
    throw new Error(
      "Pexels photo has no usable image URL."
    );
  }

  const imageResponse =
    await fetchWithTimeout(
      imageUrl,
      {
        method: "GET",
      },
      PEXELS_TIMEOUT_MS
    );

  if (!imageResponse.ok) {
    throw new Error(
      `Pexels image download failed (${imageResponse.status}).`
    );
  }

  const arrayBuffer =
    await imageResponse.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

/**
 * ------------------------------------------------------------
 * HEADLINE CLEANUP
 * ------------------------------------------------------------
 */

function cleanHeadline(
  value: string | undefined | null
): string {
  if (!value) {
    return "";
  }

  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

/**
 * ------------------------------------------------------------
 * WORD WRAPPING
 * ------------------------------------------------------------
 *
 * Maximum 3 lines.
 */

function wrapHeadline(
  headline: string,
  maxCharsPerLine = 24,
  maxLines = 3
): string {
  const words = headline
    .split(/\s+/)
    .filter(Boolean);

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current
      ? `${current} ${word}`
      : word;

    if (
      candidate.length <= maxCharsPerLine ||
      !current
    ) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;

    if (lines.length === maxLines - 1) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  /**
   * If words remain, append an ellipsis.
   */
  if (lines.length === maxLines) {
    const usedWords = lines
      .join(" ")
      .split(/\s+/).length;

    if (usedWords < words.length) {
      lines[maxLines - 1] =
        lines[maxLines - 1]
          .replace(/[.…]+$/g, "")
          .trimEnd() + "…";
    }
  }

  return lines.join("\n");
}

/**
 * ------------------------------------------------------------
 * XML / PANGO ESCAPE
 * ------------------------------------------------------------
 */

function escapePangoText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * ------------------------------------------------------------
 * FONT SIZE
 * ------------------------------------------------------------
 */

function getHeadlineFontSize(
  lines: string[]
): number {
  const longest = Math.max(
    ...lines.map((line) => line.length)
  );

  if (lines.length >= 3) {
    if (longest > 24) return 48;
    if (longest > 20) return 54;
    return 60;
  }

  if (longest > 30) return 52;
  if (longest > 24) return 60;
  if (longest > 18) return 68;

  return 76;
}

/**
 * ------------------------------------------------------------
 * CREATE TEXT LAYER
 * ------------------------------------------------------------
 *
 * This is the important fix.
 *
 * Instead of:
 *
 *   SVG <text font-family="HeadlineFont">
 *
 * we use:
 *
 *   sharp({
 *     text: {
 *       fontfile: "/absolute/path/to/font.ttf"
 *     }
 *   })
 *
 * Sharp officially supports `fontfile` as an absolute
 * filesystem path. This avoids relying on whichever font
 * happens to exist on the Vercel Linux runtime.
 */

async function createTextLayer(
  text: string,
  options: {
    color: string;
    fontSize: number;
    width: number;
    height: number;
  }
): Promise<Buffer> {
  const safeText = escapePangoText(text);

  const fontName = FONT_FILE
    ? "DejaVu Sans Bold"
    : "sans Bold";

  const fontDefinition =
    `${fontName} ${options.fontSize}`;

  const pangoText =
    `<span foreground="${options.color}">${safeText}</span>`;

  const textInput: Parameters<
    typeof sharp
  >[0] = {
    text: {
      text: pangoText,
      font: fontDefinition,
      width: options.width,
      height: options.height,
      align: "center",
      rgba: true,
      spacing: 8,

      ...(FONT_FILE
        ? {
            fontfile: FONT_FILE,
          }
        : {}),
    },
  };

  return sharp(textInput)
    .png()
    .toBuffer();
}

/**
 * ------------------------------------------------------------
 * TWEMOJI
 * ------------------------------------------------------------
 *
 * We don't use SVG text for the headline anymore.
 *
 * Twemoji is only used as an image overlay.
 */

function getTwemojiCodePoint(
  value: string
): string {
  return [...value]
    .map((char) => {
      const code = char
        .codePointAt(0)
        ?.toString(16);

      return code ?? "";
    })
    .filter(Boolean)
    .join("-");
}

async function fetchTwemoji(
  emoji: string
): Promise<Buffer | null> {
  const codePoint =
    getTwemojiCodePoint(emoji);

  if (!codePoint) {
    return null;
  }

  const url =
    `https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/${codePoint}.svg`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "image/svg+xml",
        },
      },
      10_000
    );

    if (!response.ok) {
      return null;
    }

    const svg =
      await response.arrayBuffer();

    return await sharp(
      Buffer.from(svg)
    )
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * ------------------------------------------------------------
 * SIMPLE EMOJI EXTRACTION
 * ------------------------------------------------------------
 *
 * We deliberately handle the common emoji ranges.
 * Unknown emoji remain part of the text.
 */

function extractSimpleEmoji(
  text: string
): {
  text: string;
  emoji: string[];
} {
  const emoji: string[] = [];

  const result = text.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,
    (match) => {
      emoji.push(match);
      return "";
    }
  );

  return {
    text: result
      .replace(/\s+/g, " ")
      .trim(),
    emoji,
  };
}

/**
 * ------------------------------------------------------------
 * ADD HEADLINE
 * ------------------------------------------------------------
 */

async function addHeadline(
  image: Buffer,
  title?: string
): Promise<Buffer> {
  const headline = cleanHeadline(title);

  if (!headline) {
    return image;
  }

  const {
    text: headlineWithoutEmoji,
    emoji,
  } = extractSimpleEmoji(headline);

  const wrapped = wrapHeadline(
    headlineWithoutEmoji || headline
  );

  const lines = wrapped.split("\n");

  const fontSize =
    getHeadlineFontSize(lines);

  /**
   * Main text area.
   */
  const textWidth = 920;
  const textHeight =
    lines.length >= 3 ? 300 : 240;

  /**
   * Black outline layer.
   */
  const blackLayer =
    await createTextLayer(
      wrapped,
      {
        color: "#000000",
        fontSize: fontSize + 5,
        width: textWidth,
        height: textHeight,
      }
    );

  /**
   * White main layer.
   */
  const whiteLayer =
    await createTextLayer(
      wrapped,
      {
        color: "#FFFFFF",
        fontSize,
        width: textWidth,
        height: textHeight,
      }
    );

  /**
   * Slight translucent dark panel.
   *
   * This makes white text readable on both light
   * and dark images.
   */
  const panelHeight =
    lines.length >= 3 ? 360 : 300;

  const panel =
    await sharp({
      create: {
        width: FINAL_WIDTH,
        height: panelHeight,
        channels: 4,
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0.28,
        },
      },
    })
      .png()
      .toBuffer();

  /**
   * Composite text toward the bottom.
   */
  let output =
    sharp(image).composite([
      {
        input: panel,
        gravity: "south",
      },

      /**
       * Black outline.
       */
      {
        input: blackLayer,
        gravity: "south",
        top: -120,
      },

      {
        input: blackLayer,
        gravity: "south",
        top: -124,
      },

      {
        input: blackLayer,
        gravity: "south",
        left: -3,
        top: -122,
      },

      {
        input: blackLayer,
        gravity: "south",
        left: 3,
        top: -122,
      },

      /**
       * White main text.
       */
      {
        input: whiteLayer,
        gravity: "south",
        top: -122,
      },
    ]);

  /**
   * Add one Twemoji image if the title contains emoji.
   *
   * Multiple emoji are intentionally combined into a
   * compact visual row.
   */
  if (emoji.length > 0) {
    const uniqueEmoji = [
      ...new Set(emoji),
    ].slice(0, 3);

    const emojiBuffers: Buffer[] = [];

    for (const item of uniqueEmoji) {
      const buffer =
        await fetchTwemoji(item);

      if (buffer) {
        emojiBuffers.push(buffer);
      }
    }

    if (emojiBuffers.length) {
      const emojiSize =
        lines.length >= 3 ? 58 : 66;

      const resized =
        await Promise.all(
          emojiBuffers.map((buffer) =>
            sharp(buffer)
              .resize({
                width: emojiSize,
                height: emojiSize,
                fit: "contain",
              })
              .png()
              .toBuffer()
          )
        );

      /**
       * Build emoji strip.
       */
      const stripWidth =
        resized.length * emojiSize +
        Math.max(0, resized.length - 1) * 8;

      let strip =
        sharp({
          create: {
            width: stripWidth,
            height: emojiSize,
            channels: 4,
            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0,
            },
          },
        });

      const emojiComposite =
        resized.map(
          (buffer, index) => ({
            input: buffer,
            left:
              index *
              (emojiSize + 8),
            top: 0,
          })
        );

      const stripBuffer =
        await strip
          .composite(emojiComposite)
          .png()
          .toBuffer();

      output =
        output.composite([
          {
            input: stripBuffer,
            gravity: "south",
            top: -35,
          },
        ]);
    }
  }

  return output
    .jpeg({
      quality: 92,
      chromaSubsampling: "4:4:4",
      progressive: true,
    })
    .toBuffer();
}

/**
 * ------------------------------------------------------------
 * PREPARE FINAL IMAGE
 * ------------------------------------------------------------
 */

async function composeFinalImage(
  sourceImage: Buffer,
  title?: string
): Promise<Buffer> {
  /**
   * autoOrient:
   * Prevents images with EXIF orientation from appearing
   * rotated incorrectly.
   *
   * cover:
   * Guarantees exactly 1080x1080.
   */
  const square =
    await sharp(sourceImage)
      .autoOrient()
      .resize({
        width: FINAL_WIDTH,
        height: FINAL_HEIGHT,
        fit: "cover",
        position: "attention",
        withoutEnlargement: false,
      })
      .flatten({
        background: "#111111",
      })
      .jpeg({
        quality: 94,
        chromaSubsampling: "4:4:4",
      })
      .toBuffer();

  return addHeadline(
    square,
    title
  );
}

/**
 * ------------------------------------------------------------
 * SUPABASE UPLOAD
 * ------------------------------------------------------------
 */

async function uploadImage(
  image: Buffer
): Promise<string> {
  const supabase =
    supabaseAdmin();

  const now = new Date();

  const datePath = [
    now.getUTCFullYear(),
    String(
      now.getUTCMonth() + 1
    ).padStart(2, "0"),
    String(
      now.getUTCDate()
    ).padStart(2, "0"),
  ].join("-");

  const filePath =
    `${datePath}/${randomUUID()}.jpg`;

  const {
    error,
  } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(
      filePath,
      image,
      {
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: false,
      }
    );

  if (error) {
    throw new Error(
      `Supabase image upload failed: ${error.message}`
    );
  }

  const {
    data,
  } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(filePath);

  if (!data.publicUrl) {
    throw new Error(
      "Supabase did not return a public image URL."
    );
  }

  return data.publicUrl;
}

/**
 * ------------------------------------------------------------
 * MAIN GENERATOR
 * ------------------------------------------------------------
 */

export async function generateImage(
  prompt: string,
  pref: ImageSourcePref,
  title?: string
): Promise<{
  url: string;
  source: ImageSource;
}> {
  if (!prompt?.trim()) {
    throw new Error(
      "Image prompt cannot be empty."
    );
  }

  /**
   * ----------------------------------------------------------
   * AI FIRST
   * ----------------------------------------------------------
   */

  if (pref === "ai") {
    try {
      console.log(
        "[image] Generating image with Gemini..."
      );

      const source =
        await generateWithGemini(
          prompt,
          title
        );

      console.log(
        "[image] Gemini image received:",
        source.length,
        "bytes"
      );

      const finalImage =
        await composeFinalImage(
          source,
          title
        );

      const url =
        await uploadImage(
          finalImage
        );

      console.log(
        "[image] Gemini image uploaded:",
        url
      );

      return {
        url,
        source: "ai",
      };
    } catch (error) {
      console.error(
        "[image] Gemini failed. Falling back to Pexels.",
        error
      );

      /**
       * Fallback to stock.
       */
      try {
        const source =
          await generateWithPexels(
            prompt,
            title
          );

        const finalImage =
          await composeFinalImage(
            source,
            title
          );

        const url =
          await uploadImage(
            finalImage
          );

        return {
          url,
          source: "stock",
        };
      } catch (fallbackError) {
        console.error(
          "[image] Pexels fallback failed.",
          fallbackError
        );

        throw new Error(
          `Image generation failed. Gemini and Pexels both failed.`
        );
      }
    }
  }

  /**
   * ----------------------------------------------------------
   * STOCK FIRST
   * ----------------------------------------------------------
   */

  if (pref === "stock") {
    try {
      console.log(
        "[image] Getting image from Pexels..."
      );

      const source =
        await generateWithPexels(
          prompt,
          title
        );

      const finalImage =
        await composeFinalImage(
          source,
          title
        );

      const url =
        await uploadImage(
          finalImage
        );

      console.log(
        "[image] Pexels image uploaded:",
        url
      );

      return {
        url,
        source: "stock",
      };
    } catch (error) {
      console.error(
        "[image] Pexels failed. Falling back to Gemini.",
        error
      );

      try {
        const source =
          await generateWithGemini(
            prompt,
            title
          );

        const finalImage =
          await composeFinalImage(
            source,
            title
          );

        const url =
          await uploadImage(
            finalImage
          );

        return {
          url,
          source: "ai",
        };
      } catch (fallbackError) {
        console.error(
          "[image] Gemini fallback failed.",
          fallbackError
        );

        throw new Error(
          "Image generation failed. Pexels and Gemini both failed."
        );
      }
    }
  }

  /**
   * ----------------------------------------------------------
   * MIXED
   * ----------------------------------------------------------
   *
   * Randomly chooses AI or stock.
   */

  const useAi =
    Math.random() >= 0.5;

  return generateImage(
    prompt,
    useAi ? "ai" : "stock",
    title
  );
}

/**
 * ------------------------------------------------------------
 * OPTIONAL DEFAULT EXPORT
 * ------------------------------------------------------------
 */

export default generateImage;

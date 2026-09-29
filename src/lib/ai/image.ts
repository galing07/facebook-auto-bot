import { randomUUID } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import twemoji from "@twemoji/api";

import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/server";

import type {
  ImageSource,
  ImageSourcePref,
} from "@/lib/types";

/*
 * IMPORTANT
 * ------------------------------------------------------------
 * Do NOT statically import sharp here.
 *
 * Fontconfig must be configured before libvips/Sharp attempts
 * to render SVG text.
 */
import type sharpType from "sharp";

const STORAGE_BUCKET = "post-images";

const GEMINI_IMAGE_MODEL =
  "gemini-3.1-flash-image";

const GEMINI_IMAGE_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const GEMINI_TIMEOUT_MS = 90_000;
const PEXELS_TIMEOUT_MS = 20_000;

// ============================================================
// FINAL IMAGE
// ============================================================

const FINAL_WIDTH = 1080;
const FINAL_HEIGHT = 1080;

// ============================================================
// SHARP LOADER
// ============================================================

let sharpInstance:
  | typeof sharpType
  | null = null;

async function getSharp(): Promise<
  typeof sharpType
> {
  if (sharpInstance) {
    return sharpInstance;
  }

  /*
   * Configure fonts BEFORE importing Sharp.
   */
  configureServerlessFonts();

  const module =
    await import("sharp");

  sharpInstance =
    module.default;

  return sharpInstance;
}

// ============================================================
// SERVERLESS FONT CONFIG
// ============================================================

let fontConfigured = false;

function configureServerlessFonts(): void {
  if (fontConfigured) {
    return;
  }

  fontConfigured = true;

  try {
    const projectRoot =
      process.cwd();

    /*
     * Expected repository structure:
     *
     * fonts/
     *   DejaVuSans-Bold.ttf
     *
     * fontconfig/
     *   fonts.conf
     */
    const fontsDir =
      path.join(
        projectRoot,
        "fonts"
      );

    const bundledFont =
      path.join(
        fontsDir,
        "DejaVuSans-Bold.ttf"
      );

    /*
     * Vercel can use /tmp for fontconfig cache.
     */
    const cacheDir =
      path.join(
        os.tmpdir(),
        "facebook-auto-bot-fontconfig"
      );

    const fontConfigDir =
      path.join(
        os.tmpdir(),
        "facebook-auto-bot-fontconfig-config"
      );

    const fontsConf =
      path.join(
        fontConfigDir,
        "fonts.conf"
      );

    fs.mkdirSync(
      cacheDir,
      {
        recursive: true,
      }
    );

    fs.mkdirSync(
      fontConfigDir,
      {
        recursive: true,
      }
    );

    if (
      !fs.existsSync(
        bundledFont
      )
    ) {
      console.warn(
        `[IMAGE] WARNING: bundled font not found: ${bundledFont}`
      );

      /*
       * We still configure fontconfig.
       * Linux system fonts may be available.
       */
    }

    /*
     * Generate an absolute fontconfig file.
     *
     * This avoids relying on the current working directory
     * inside Vercel's serverless runtime.
     */
    const fontConfigXml =
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${escapeXml(
    fontsDir
  )}</dir>

  <cachedir>${escapeXml(
    cacheDir
  )}</cachedir>

  <match target="pattern">
    <test name="family">
      <string>HeadlineFont</string>
    </test>
    <edit name="family" mode="prepend" binding="strong">
      <string>DejaVu Sans</string>
    </edit>
  </match>

  <match target="pattern">
    <test name="family">
      <string>DejaVu Sans</string>
    </test>
    <edit name="family" mode="prepend" binding="strong">
      <string>DejaVu Sans</string>
    </edit>
  </match>
</fontconfig>`;

    fs.writeFileSync(
      fontsConf,
      fontConfigXml,
      "utf8"
    );

    /*
     * FONTCONFIG_PATH points to directory.
     */
    process.env.FONTCONFIG_PATH =
      fontConfigDir;

    /*
     * FONTCONFIG_FILE can be an absolute config path.
     */
    process.env.FONTCONFIG_FILE =
      fontsConf;

    console.info(
      `[IMAGE] Fontconfig configured`
    );

    console.info(
      `[IMAGE] Font directory=${fontsDir}`
    );

    console.info(
      `[IMAGE] Font config=${fontsConf}`
    );

    console.info(
      `[IMAGE] Bundled font exists=${fs.existsSync(
        bundledFont
      )}`
    );
  } catch (error) {
    console.warn(
      "[IMAGE] Fontconfig configuration failed:",
      error
    );
  }
}

// ============================================================
// SOURCE RESOLUTION
// ============================================================

export function resolveImageSource(
  pref: ImageSourcePref
): ImageSource {
  if (pref === "mixed") {
    return Math.random() < 0.5
      ? "ai"
      : "stock";
  }

  return pref;
}

// ============================================================
// GEMINI PROMPT
// ============================================================

const PHOTO_STYLE = [
  "photorealistic",
  "professional photography",
  "natural lighting",
  "realistic details",
  "high detail",
  "clean composition",
  "single scene",
  "single image",
  "no watermark",
  "no logo",
  "no text",
  "no letters",
  "no typography",
  "no collage",
  "no grid",
].join(", ");

function detectVisualCategory(
  prompt: string
): {
  category: string;
  subject: string;
  keywords: string;
} {
  const text = prompt
    .toLowerCase()
    .replace(
      /[^a-z0-9\s-]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();

  const rules: Array<{
    category: string;
    keywords: string[];
    subject: string;
    visual: string;
  }> = [
    {
      category: "FOOD",
      keywords: [
        "food",
        "foods",
        "foodie",
        "cuisine",
        "dish",
        "meal",
        "recipe",
        "cooking",
        "cook",
        "restaurant",
        "dining",
        "eat",
        "eating",
        "street food",
        "fast food",
        "dessert",
        "cake",
        "pizza",
        "burger",
        "noodle",
        "ramen",
        "sushi",
        "coffee",
        "drink",
        "beverage",
        "culinary",
        "snack",
        "breakfast",
        "lunch",
        "dinner",
      ],
      subject:
        "food and culinary content",
      visual:
        "an appetizing food dish as the clear main subject, attractive presentation, realistic ingredients, restaurant or street-food atmosphere, close-up culinary photography",
    },

    {
      category: "TRAVEL",
      keywords: [
        "travel",
        "traveling",
        "travelling",
        "tour",
        "tourism",
        "tourist",
        "trip",
        "journey",
        "vacation",
        "holiday",
        "destination",
        "explore",
        "exploring",
        "adventure",
        "beach",
        "island",
        "mountain",
        "waterfall",
        "city",
        "landmark",
        "hotel",
        "resort",
        "airport",
        "road trip",
      ],
      subject:
        "travel and tourism",
      visual:
        "a beautiful travel destination as the clear main subject, scenic landscape or recognizable tourist environment, travel atmosphere, exploration and vacation feeling, professional travel photography",
    },

    {
      category: "TECHNOLOGY",
      keywords: [
        "technology",
        "tech",
        "gadget",
        "smartphone",
        "phone",
        "iphone",
        "android",
        "computer",
        "laptop",
        "software",
        "ai",
        "artificial intelligence",
        "robot",
        "internet",
        "digital",
        "app",
        "device",
        "electronics",
      ],
      subject:
        "technology and digital innovation",
      visual:
        "modern technology as the clear main subject, contemporary devices or digital innovation, realistic workspace or technological environment, premium technology photography",
    },

    {
      category: "HEALTH",
      keywords: [
        "health",
        "healthy",
        "wellness",
        "fitness",
        "exercise",
        "workout",
        "gym",
        "nutrition",
        "diet",
        "healthcare",
        "medical",
        "doctor",
        "medicine",
        "wellbeing",
        "lifestyle",
      ],
      subject:
        "health and wellness",
      visual:
        "a realistic healthy lifestyle scene as the clear main subject, healthy food, exercise, wellness activity, or appropriate healthcare context depending on the topic",
    },

    {
      category: "FASHION",
      keywords: [
        "fashion",
        "style",
        "clothing",
        "outfit",
        "dress",
        "shoes",
        "sneakers",
        "beauty",
        "makeup",
        "model",
        "designer",
        "trend",
        "trendy",
      ],
      subject:
        "fashion and style",
      visual:
        "fashion and style as the clear main subject, contemporary clothing or styling, realistic editorial photography, attractive modern presentation",
    },

    {
      category: "SPORTS",
      keywords: [
        "sport",
        "sports",
        "football",
        "soccer",
        "basketball",
        "tennis",
        "baseball",
        "boxing",
        "running",
        "athlete",
        "olympic",
        "fitness",
        "match",
        "game",
      ],
      subject:
        "sports and athletic activity",
      visual:
        "a realistic sports scene with the relevant athletic activity as the clear main subject, dynamic action, authentic sporting environment, professional sports photography",
    },

    {
      category: "NATURE",
      keywords: [
        "nature",
        "wildlife",
        "animal",
        "animals",
        "forest",
        "jungle",
        "lake",
        "river",
        "ocean",
        "sunset",
        "sunrise",
        "garden",
        "flower",
        "flowers",
        "landscape",
      ],
      subject:
        "nature and environment",
      visual:
        "a beautiful natural environment or relevant wildlife as the clear main subject, realistic landscape photography, natural atmosphere and detailed scenery",
    },

    {
      category: "BUSINESS",
      keywords: [
        "business",
        "finance",
        "money",
        "market",
        "marketing",
        "startup",
        "entrepreneur",
        "company",
        "investment",
        "economy",
        "office",
        "career",
        "work",
        "job",
      ],
      subject:
        "business and professional life",
      visual:
        "a realistic professional business scene related to the topic, modern workplace, professional people or relevant financial/business environment, editorial business photography",
    },
  ];

  for (const rule of rules) {
    if (
      rule.keywords.some(
        (keyword) =>
          text === keyword ||
          text.includes(
            ` ${keyword} `
          ) ||
          text.startsWith(
            `${keyword} `
          ) ||
          text.endsWith(
            ` ${keyword}`
          )
      )
    ) {
      return {
        category:
          rule.category,
        subject:
          rule.subject,
        keywords:
          rule.visual,
      };
    }
  }

  return {
    category: "GENERAL",
    subject:
      "the topic provided",
    keywords:
      "a realistic scene directly representing the main subject and meaning of the topic, with the topic's primary object or activity clearly visible",
  };
}

function buildVisualPrompt(
  prompt: string
): string {
  const cleanPrompt =
    prompt.trim();

  const detected =
    detectVisualCategory(
      cleanPrompt
    );

  return [
    `TOPIC: ${cleanPrompt}`,
    `VISUAL CATEGORY: ${detected.category}`,
    `SUBJECT: ${detected.subject}`,
    "",
    "CREATE THIS EXACT VISUAL SUBJECT:",
    detected.keywords,
    "",
    "The image must clearly represent the topic above.",
    "Do not create a generic lifestyle image when the topic has a specific subject.",
    "The main subject must be immediately recognizable from the topic.",
  ].join("\n");
}

function buildGeminiPrompt(
  prompt: string,
  _title: string
): string {
  const visualPrompt =
    buildVisualPrompt(
      prompt
    );

  return [
    "Create a high-quality square social media photograph.",
    "",
    visualPrompt,
    "",
    "IMPORTANT:",
    "- The TOPIC controls the visual subject.",
    "- Match the image directly to the topic.",
    "- If the topic is food, show food.",
    "- If the topic is travel, show travel, a destination, scenery, or tourism.",
    "- If the topic is technology, show technology.",
    "- If the topic is health, show health or wellness.",
    "- Do NOT substitute an unrelated subject.",
    "- Create the image only.",
    "- Do NOT add text, letters, words, captions, headlines, typography, signs, labels, logos, or watermarks.",
    "- The Facebook headline will be added separately by Sharp.",
    "",
    "VISUAL STYLE:",
    PHOTO_STYLE,
    "",
    "COMPOSITION:",
    "- 1:1 square composition.",
    "- Designed for a Facebook mobile feed.",
    "- Strong visual hierarchy.",
    "- Main subject must remain visually dominant.",
    "- Professional social-media photography aesthetic.",
  ].join("\n");
}

// ============================================================
// PEXELS SEARCH QUERY
// ============================================================

function buildPexelsQuery(
  prompt: string
): string {
  const detected =
    detectVisualCategory(
      prompt
    );

  const categoryQuery: Record<
    string,
    string
  > = {
    FOOD:
      "food culinary delicious dish",
    TRAVEL:
      "travel destination tourism landscape",
    TECHNOLOGY:
      "technology gadgets digital",
    HEALTH:
      "healthy lifestyle wellness fitness",
    FASHION:
      "fashion style clothing",
    SPORTS:
      "sports athlete action",
    NATURE:
      "nature landscape wildlife",
    BUSINESS:
      "business professional office",
    GENERAL:
      "lifestyle",
  };

  const categoryBase =
    categoryQuery[
      detected.category
    ] ??
    "lifestyle";

  const topicText =
    prompt
      .replace(
        /^a\s+realistic\s+cinematic\s+photograph\s+related\s+to\s+/i,
        " "
      )
      .replace(
        /^a\s+realistic\s+photograph\s+related\s+to\s+/i,
        " "
      )
      .replace(
        /visually compelling composition/gi,
        " "
      )
      .replace(
        /natural lighting/gi,
        " "
      )
      .replace(
        /high detail/gi,
        " "
      )
      .replace(
        /realistic photography/gi,
        " "
      )
      .replace(
        /professional facebook social media design/gi,
        " "
      )
      .replace(
        /1:1 square composition/gi,
        " "
      )
      .replace(
        /bold overlay text/gi,
        " "
      )
      .replace(
        /centered near the bottom/gi,
        " "
      )
      .replace(
        /large modern bold typography/gi,
        " "
      )
      .replace(
        /subtle dark contrast box/gi,
        " "
      )
      .replace(
        /highly readable on a mobile screen/gi,
        " "
      )
      .replace(
        /no hashtags|no url|no logo|no watermark|no text|no letters|no words|no captions|no headlines|no typography/gi,
        " "
      )
      .replace(
        /[^a-zA-Z0-9À-ÿ\s-]/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const topicWords =
    topicText
      .split(/\s+/)
      .filter(Boolean);

  const genericWords =
    new Set([
      "today",
      "new",
      "latest",
      "viral",
      "worth",
      "look",
      "must",
      "see",
      "interesting",
      "amazing",
      "beautiful",
      "best",
      "news",
      "trending",
      "trend",
    ]);

  const usefulWords =
    topicWords
      .filter(
        (word) =>
          !genericWords.has(
            word.toLowerCase()
          )
      )
      .slice(0, 6);

  const query = [
    categoryBase,
    ...usefulWords,
  ]
    .join(" ")
    .trim();

  console.info(
    `[IMAGE] Visual category=${detected.category} Pexels query="${query}"`
  );

  return (
    query ||
    categoryBase
  );
}

// ============================================================
// GEMINI IMAGE GENERATION
// ============================================================

async function fetchGeminiImageBytes(
  prompt: string,
  title: string
): Promise<Blob> {
  const apiKey =
    env.geminiApiKey;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }

  const cleanTitle =
    title.trim();

  if (!cleanTitle) {
    throw new Error(
      "Facebook headline is required before Gemini image generation."
    );
  }

  const finalPrompt =
    buildGeminiPrompt(
      prompt,
      cleanTitle
    );

  console.info(
    `[IMAGE] Gemini starting model=${GEMINI_IMAGE_MODEL}`
  );

  console.info(
    `[IMAGE] Gemini headline="${cleanTitle}"`
  );

  const requestBody = {
    model:
      GEMINI_IMAGE_MODEL,

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
  };

  const response =
    await fetch(
      GEMINI_IMAGE_ENDPOINT,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-goog-api-key":
            apiKey,
        },

        body:
          JSON.stringify(
            requestBody
          ),

        signal:
          AbortSignal.timeout(
            GEMINI_TIMEOUT_MS
          ),
      }
    );

  const body =
    await response.text();

  console.info(
    `[IMAGE] Gemini HTTP ${response.status}`
  );

  if (!response.ok) {
    console.error(
      "[IMAGE] Gemini API error:",
      body.slice(0, 1500)
    );

    throw new Error(
      `Gemini image API HTTP ${response.status}: ${body.slice(
        0,
        500
      )}`
    );
  }

  let data: any;

  try {
    data =
      JSON.parse(body);
  } catch {
    console.error(
      "[IMAGE] Gemini returned non-JSON:",
      body.slice(0, 1000)
    );

    throw new Error(
      "Gemini returned invalid JSON"
    );
  }

  const outputImage =
    data?.output_image;

  if (
    outputImage &&
    typeof outputImage.data ===
      "string" &&
    outputImage.data.length > 0
  ) {
    const mimeType =
      typeof outputImage.mime_type ===
      "string"
        ? outputImage.mime_type
        : "image/jpeg";

    const bytes =
      Buffer.from(
        outputImage.data,
        "base64"
      );

    if (bytes.length === 0) {
      throw new Error(
        "Gemini returned empty image data"
      );
    }

    console.info(
      `[IMAGE] Gemini SUCCESS output_image bytes=${bytes.length}`
    );

    return new Blob(
      [bytes],
      {
        type: mimeType,
      }
    );
  }

  const steps =
    Array.isArray(data?.steps)
      ? data.steps
      : [];

  for (const step of steps) {
    const content =
      Array.isArray(
        step?.content
      )
        ? step.content
        : [];

    for (const item of content) {
      if (
        item?.type === "image" &&
        typeof item?.data ===
          "string" &&
        item.data.length > 0
      ) {
        const mimeType =
          typeof item.mime_type ===
          "string"
            ? item.mime_type
            : "image/jpeg";

        const bytes =
          Buffer.from(
            item.data,
            "base64"
          );

        if (bytes.length === 0) {
          continue;
        }

        console.info(
          `[IMAGE] Gemini SUCCESS steps image bytes=${bytes.length}`
        );

        return new Blob(
          [bytes],
          {
            type: mimeType,
          }
        );
      }
    }
  }

  console.error(
    "[IMAGE] Gemini response contained no image."
  );

  console.error(
    "[IMAGE] Gemini response keys:",
    Object.keys(data ?? {})
  );

  throw new Error(
    "Gemini completed but returned no image data"
  );
}

// ============================================================
// PEXELS
// ============================================================

async function fetchStockImageBytes(
  prompt: string
): Promise<Blob> {
  const apiKey =
    env.pexelsApiKey;

  if (!apiKey) {
    throw new Error(
      "PEXELS_API_KEY is not configured"
    );
  }

  const query =
    buildPexelsQuery(
      prompt
    );

  console.info(
    `[IMAGE] Pexels query="${query}"`
  );

  const searchUrl =
    new URL(
      "https://api.pexels.com/v1/search"
    );

  searchUrl.searchParams.set(
    "query",
    query
  );

  searchUrl.searchParams.set(
    "orientation",
    "square"
  );

  searchUrl.searchParams.set(
    "size",
    "large"
  );

  searchUrl.searchParams.set(
    "per_page",
    "15"
  );

  const response =
    await fetch(
      searchUrl.toString(),
      {
        method: "GET",

        headers: {
          Authorization:
            apiKey,
        },

        signal:
          AbortSignal.timeout(
            PEXELS_TIMEOUT_MS
          ),
      }
    );

  const body =
    await response.text();

  console.info(
    `[IMAGE] Pexels HTTP ${response.status}`
  );

  if (!response.ok) {
    console.error(
      "[IMAGE] Pexels API error:",
      body.slice(0, 1000)
    );

    throw new Error(
      `Pexels HTTP ${response.status}: ${body.slice(
        0,
        500
      )}`
    );
  }

  let data: any;

  try {
    data =
      JSON.parse(body);
  } catch {
    throw new Error(
      "Pexels returned invalid JSON"
    );
  }

  const photos =
    Array.isArray(
      data?.photos
    )
      ? data.photos
      : [];

  if (photos.length === 0) {
    throw new Error(
      `Pexels returned no photos for query "${query}"`
    );
  }

  const validPhotos =
    photos.filter(
      (photo: any) =>
        typeof photo?.src?.large2x ===
          "string" ||
        typeof photo?.src?.large ===
          "string"
    );

  if (
    validPhotos.length === 0
  ) {
    throw new Error(
      "Pexels returned photos without usable URLs"
    );
  }

  const selected =
    validPhotos[
      Math.floor(
        Math.random() *
          validPhotos.length
      )
    ];

  const imageUrl =
    selected.src.large2x ??
    selected.src.large;

  console.info(
    "[IMAGE] Pexels downloading selected photo"
  );

  const imageResponse =
    await fetch(
      imageUrl,
      {
        method: "GET",

        signal:
          AbortSignal.timeout(
            PEXELS_TIMEOUT_MS
          ),
      }
    );

  if (!imageResponse.ok) {
    throw new Error(
      `Pexels image download HTTP ${imageResponse.status}`
    );
  }

  const blob =
    await imageResponse.blob();

  if (
    !blob.type ||
    !blob.type.startsWith(
      "image/"
    )
  ) {
    throw new Error(
      `Pexels returned invalid content type: ${blob.type}`
    );
  }

  if (blob.size === 0) {
    throw new Error(
      "Pexels returned an empty image"
    );
  }

  console.info(
    `[IMAGE] Pexels SUCCESS size=${blob.size} type=${blob.type}`
  );

  return blob;
}

// ============================================================
// SVG ESCAPE
// ============================================================

function escapeXml(
  value: string
): string {
  return value
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&apos;"
    );
}

// ============================================================
// CLEAN HEADLINE
// ============================================================

function cleanHeadline(
  title: string
): string {
  return title
    .trim()
    .replace(
      /[\u0000-\u001F\u007F]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

// ============================================================
// HEADLINE WRAPPING
// ============================================================

function wrapHeadline(
  title: string,
  maxChars = 22
): string[] {
  const words =
    title
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  const lines: string[] =
    [];

  let current = "";

  for (const word of words) {
    if (
      word.length >
        maxChars &&
      !current
    ) {
      let remaining =
        word;

      while (
        remaining.length >
        maxChars
      ) {
        lines.push(
          remaining.slice(
            0,
            maxChars
          )
        );

        remaining =
          remaining.slice(
            maxChars
          );
      }

      current =
        remaining;

      continue;
    }

    const candidate =
      current
        ? `${current} ${word}`
        : word;

    if (
      candidate.length <=
      maxChars
    ) {
      current =
        candidate;
    } else {
      if (current) {
        lines.push(
          current
        );
      }

      current =
        word;
    }
  }

  if (current) {
    lines.push(
      current
    );
  }

  /*
   * Maximum 3 lines.
   *
   * Never delete headline characters.
   */
  if (lines.length <= 3) {
    return lines;
  }

  return [
    lines[0],
    lines[1],
    lines
      .slice(2)
      .join(" "),
  ];
}

// ============================================================
// HEADLINE SVG
// ============================================================

async function createHeadlineSvg(
  title: string
): Promise<Buffer> {
  const cleanTitle =
    cleanHeadline(title);

  if (!cleanTitle) {
    throw new Error(
      "Headline title is empty after cleaning."
    );
  }

  const lines =
    wrapHeadline(
      cleanTitle,
      22
    );

  if (!lines.length) {
    throw new Error(
      "Unable to create headline overlay."
    );
  }

  /*
   * Font sizes.
   */
  const fontSize =
    lines.length === 1
      ? 76
      : lines.length === 2
        ? 64
        : 54;

  const lineHeight =
    fontSize + 18;

  const totalTextHeight =
    lines.length *
    lineHeight;

  const bottomMargin =
    75;

  const firstTextY =
    FINAL_HEIGHT -
    totalTextHeight -
    bottomMargin;

  const CENTER_X =
    FINAL_WIDTH / 2;

  /*
   * IMPORTANT
   *
   * This family is mapped through our bundled
   * DejaVu font + fontconfig.
   *
   * Do NOT use Arial.
   */
  const FONT_FAMILY =
    "HeadlineFont";

  // ----------------------------------------------------------
  // TWEMOJI
  // ----------------------------------------------------------

  const twemojiBase =
    "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/";

  const emojiRegex =
    /(?:[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}])(?:\uFE0F|\u200D(?:[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}])(?:\uFE0F)?)*|\uFE0F/gu;

  const emojiCache =
    new Map<
      string,
      string
    >();

  async function emojiDataUri(
    emoji: string
  ): Promise<
    string | null
  > {
    const codePoint =
      twemoji.convert
        .toCodePoint(
          emoji
        )
        .toLowerCase();

    if (!codePoint) {
      return null;
    }

    const cached =
      emojiCache.get(
        codePoint
      );

    if (cached) {
      return cached;
    }

    try {
      const response =
        await fetch(
          `${twemojiBase}${codePoint}.svg`,
          {
            signal:
              AbortSignal.timeout(
                10_000
              ),
          }
        );

      if (!response.ok) {
        console.warn(
          `[IMAGE] Twemoji HTTP ${response.status} for ${emoji}`
        );

        return null;
      }

      const svgText =
        await response.text();

      const dataUri =
        `data:image/svg+xml;base64,${Buffer.from(
          svgText,
          "utf8"
        ).toString(
          "base64"
        )}`;

      emojiCache.set(
        codePoint,
        dataUri
      );

      return dataUri;
    } catch (error) {
      console.warn(
        `[IMAGE] Twemoji fetch failed for ${emoji}:`,
        error
      );

      return null;
    }
  }

  // ----------------------------------------------------------
  // TEXT ELEMENTS
  // ----------------------------------------------------------

  const lineElements =
    await Promise.all(
      lines.map(
        async (
          line,
          index
        ) => {
          const y =
            firstTextY +
            index *
              lineHeight;

          const matches =
            [
              ...line.matchAll(
                emojiRegex
              ),
            ];

          const lastMatch =
            matches.length > 0
              ? matches[
                  matches.length - 1
                ]
              : null;

          const emojiPart =
            lastMatch?.index !==
            undefined
              ? lastMatch[0]
              : null;

          const textPart =
            emojiPart &&
            lastMatch?.index !==
              undefined
              ? line
                  .slice(
                    0,
                    lastMatch.index
                  )
                  .trimEnd()
              : line;

          const elements: string[] =
            [];

          // --------------------------------------------------
          // HEADLINE TEXT
          // --------------------------------------------------

          if (textPart) {
            elements.push(
              `<text
                x="${CENTER_X}"
                y="${y}"
                text-anchor="middle"
                font-family="${FONT_FAMILY}"
                font-size="${fontSize}px"
                font-weight="700"
                fill="#FFFFFF"
                stroke="#000000"
                stroke-width="8"
                stroke-linejoin="round"
                style="paint-order:stroke fill"
              >${escapeXml(
                textPart
              )}</text>`
            );
          }

          // --------------------------------------------------
          // EMOJI
          // --------------------------------------------------

          if (emojiPart) {
            const dataUri =
              await emojiDataUri(
                emojiPart
              );

            if (dataUri) {
              const estimatedTextWidth =
                Math.min(
                  textPart.length *
                    fontSize *
                    0.52,
                  FINAL_WIDTH -
                    160
                );

              const emojiWidth =
                fontSize *
                0.82;

              const emojiGap =
                16;

              let emojiX =
                CENTER_X +
                estimatedTextWidth /
                  2 +
                emojiGap;

              const rightPadding =
                50;

              if (
                emojiX +
                  emojiWidth >
                FINAL_WIDTH -
                  rightPadding
              ) {
                emojiX =
                  FINAL_WIDTH -
                  rightPadding -
                  emojiWidth;
              }

              if (
                emojiX <
                rightPadding
              ) {
                emojiX =
                  rightPadding;
              }

              const emojiY =
                y -
                fontSize *
                  0.84;

              elements.push(
                `<image
                  x="${emojiX.toFixed(
                    2
                  )}"
                  y="${emojiY.toFixed(
                    2
                  )}"
                  width="${emojiWidth.toFixed(
                    2
                  )}"
                  height="${emojiWidth.toFixed(
                    2
                  )}"
                  href="${dataUri}"
                  preserveAspectRatio="xMidYMid meet"
                />`
              );
            }
          }

          return `<g>${elements.join(
            "\n"
          )}</g>`;
        }
      )
    );

  /*
   * IMPORTANT:
   *
   * Keep SVG simple.
   *
   * No SVG filters.
   * No external fonts.
   * No Arial.
   * No unsupported SVG font declarations.
   */
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg ` +
    `xmlns="http://www.w3.org/2000/svg" ` +
    `width="${FINAL_WIDTH}" ` +
    `height="${FINAL_HEIGHT}" ` +
    `viewBox="0 0 ${FINAL_WIDTH} ${FINAL_HEIGHT}">` +
    lineElements.join(
      "\n"
    ) +
    `</svg>`;

  return Buffer.from(
    svg,
    "utf8"
  );
}

// ============================================================
// APPLY HEADLINE OVERLAY
// ============================================================

async function applyHeadlineOverlay(
  blob: Blob,
  title: string
): Promise<Blob> {
  const cleanTitle =
    cleanHeadline(title);

  if (!cleanTitle) {
    throw new Error(
      "Cannot generate final image: Facebook headline/title is empty."
    );
  }

  console.info(
    `[IMAGE] REQUIRED HEADLINE="${cleanTitle}"`
  );

  console.info(
    `[IMAGE] OVERLAY START title="${cleanTitle}"`
  );

  const inputBuffer =
    Buffer.from(
      await blob.arrayBuffer()
    );

  if (
    inputBuffer.length === 0
  ) {
    throw new Error(
      "Cannot apply headline: source image is empty."
    );
  }

  const sharp =
    await getSharp();

  // ----------------------------------------------------------
  // BASE IMAGE
  // ----------------------------------------------------------

  const baseImage =
    await sharp(
      inputBuffer
    )
      .resize(
        FINAL_WIDTH,
        FINAL_HEIGHT,
        {
          fit: "cover",
          position: "centre",
        }
      )
      .jpeg({
        quality: 92,
        mozjpeg: true,
      })
      .toBuffer();

  if (
    baseImage.length === 0
  ) {
    throw new Error(
      "Base image processing produced empty output."
    );
  }

  // ----------------------------------------------------------
  // HEADLINE SVG
  // ----------------------------------------------------------

  const svgOverlay =
    await createHeadlineSvg(
      cleanTitle
    );

  console.info(
    `[IMAGE] SVG HEADLINE CREATED bytes=${svgOverlay.length}`
  );

  if (
    svgOverlay.length < 100
  ) {
    throw new Error(
      "Headline SVG was unexpectedly empty."
    );
  }

  // ----------------------------------------------------------
  // COMPOSITE
  // ----------------------------------------------------------

  const outputBuffer =
    await sharp(
      baseImage
    )
      .composite([
        {
          input:
            svgOverlay,
          top: 0,
          left: 0,
        },
      ])
      .jpeg({
        quality: 92,
        mozjpeg: true,
      })
      .toBuffer();

  if (
    outputBuffer.length === 0
  ) {
    throw new Error(
      "Headline overlay produced an empty image."
    );
  }

  // ----------------------------------------------------------
  // VERIFY FINAL IMAGE
  // ----------------------------------------------------------

  const metadata =
    await sharp(
      outputBuffer
    ).metadata();

  if (
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error(
      "Headline overlay verification failed: invalid final image."
    );
  }

  if (
    metadata.width !==
      FINAL_WIDTH ||
    metadata.height !==
      FINAL_HEIGHT
  ) {
    throw new Error(
      `Headline overlay verification failed: expected ${FINAL_WIDTH}x${FINAL_HEIGHT}, got ${metadata.width}x${metadata.height}.`
    );
  }

  console.info(
    `[IMAGE] OVERLAY SUCCESS title="${cleanTitle}" width=${metadata.width} height=${metadata.height} bytes=${outputBuffer.length}`
  );

  return new Blob(
    [
      outputBuffer.buffer.slice(
        outputBuffer.byteOffset,
        outputBuffer.byteOffset +
          outputBuffer.byteLength
      ) as ArrayBuffer,
    ],
    {
      type:
        "image/jpeg",
    }
  );
}

// ============================================================
// PUBLIC GENERATOR
// ============================================================

export async function generateImage(
  prompt: string,
  pref: ImageSourcePref,
  title: string
): Promise<{
  url: string;
  source: ImageSource;
}> {
  const cleanPrompt =
    prompt.trim();

  const cleanTitle =
    cleanHeadline(
      title
    );

  if (!cleanPrompt) {
    throw new Error(
      "Image prompt is required."
    );
  }

  if (!cleanTitle) {
    throw new Error(
      "Facebook headline/title is required for image generation."
    );
  }

  const source =
    resolveImageSource(
      pref
    );

  console.info(
    `[IMAGE] REQUESTED SOURCE=${source}`
  );

  console.info(
    `[IMAGE] REQUIRED HEADLINE="${cleanTitle}"`
  );

  // ==========================================================
  // AI SOURCE
  // Gemini -> Sharp -> upload
  // Pexels fallback -> Sharp -> upload
  // ==========================================================

  if (
    source === "ai"
  ) {
    try {
      const baseBlob =
        await fetchGeminiImageBytes(
          cleanPrompt,
          cleanTitle
        );

      const finalBlob =
        await applyHeadlineOverlay(
          baseBlob,
          cleanTitle
        );

      return upload(
        finalBlob,
        "ai"
      );
    } catch (
      geminiError
    ) {
      const message =
        geminiError instanceof
          Error
          ? geminiError.message
          : String(
              geminiError
            );

      console.error(
        `[IMAGE] Gemini FAILED: ${message}`
      );

      try {
        const baseBlob =
          await fetchStockImageBytes(
            cleanPrompt
          );

        const finalBlob =
          await applyHeadlineOverlay(
            baseBlob,
            cleanTitle
          );

        return upload(
          finalBlob,
          "stock"
        );
      } catch (
        pexelsError
      ) {
        const message2 =
          pexelsError instanceof
            Error
            ? pexelsError.message
            : String(
                pexelsError
              );

        console.error(
          `[IMAGE] Pexels FALLBACK FAILED: ${message2}`
        );

        throw new Error(
          `Image generation failed. Gemini: ${message}. Pexels: ${message2}`
        );
      }
    }
  }

  // ==========================================================
  // STOCK SOURCE
  // Pexels -> Sharp -> upload
  // Gemini fallback -> Sharp -> upload
  // ==========================================================

  try {
    const baseBlob =
      await fetchStockImageBytes(
        cleanPrompt
      );

    const finalBlob =
      await applyHeadlineOverlay(
        baseBlob,
        cleanTitle
      );

    return upload(
      finalBlob,
      "stock"
    );
  } catch (
    pexelsError
  ) {
    const message =
      pexelsError instanceof
        Error
        ? pexelsError.message
        : String(
            pexelsError
          );

    console.error(
      `[IMAGE] Pexels FAILED: ${message}`
    );

    try {
      const baseBlob =
        await fetchGeminiImageBytes(
          cleanPrompt,
          cleanTitle
        );

      const finalBlob =
        await applyHeadlineOverlay(
          baseBlob,
          cleanTitle
        );

      return upload(
        finalBlob,
        "ai"
      );
    } catch (
      geminiError
    ) {
      const message2 =
        geminiError instanceof
          Error
          ? geminiError.message
          : String(
              geminiError
            );

      console.error(
        `[IMAGE] Gemini FALLBACK FAILED: ${message2}`
      );

      throw new Error(
        `Image generation failed. Pexels: ${message}. Gemini: ${message2}`
      );
    }
  }
}

// ============================================================
// SUPABASE STORAGE
// ============================================================

async function upload(
  blob: Blob,
  source: ImageSource
): Promise<{
  url: string;
  source: ImageSource;
}> {
  const db =
    supabaseAdmin();

  const extension =
    "jpg";

  const date =
    new Date()
      .toISOString()
      .slice(0, 10);

  const path =
    `${date}/${randomUUID()}.${extension}`;

  const bytes =
    new Uint8Array(
      await blob.arrayBuffer()
    );

  if (bytes.length === 0) {
    throw new Error(
      "Cannot upload empty image."
    );
  }

  console.info(
    `[IMAGE] SUPABASE UPLOAD source=${source} path=${path} size=${bytes.length}`
  );

  const {
    error,
  } =
    await db.storage
      .from(
        STORAGE_BUCKET
      )
      .upload(
        path,
        bytes,
        {
          contentType:
            "image/jpeg",
          upsert: false,
        }
      );

  if (error) {
    throw new Error(
      `Supabase Storage upload failed: ${error.message}`
    );
  }

  const {
    data,
  } =
    db.storage
      .from(
        STORAGE_BUCKET
      )
      .getPublicUrl(
        path
      );

  if (
    !data?.publicUrl
  ) {
    throw new Error(
      "Supabase did not return public image URL."
    );
  }

  console.info(
    `[IMAGE] SUPABASE UPLOAD SUCCESS source=${source} url=${data.publicUrl}`
  );

  return {
    url:
      data.publicUrl,
    source,
  };
}

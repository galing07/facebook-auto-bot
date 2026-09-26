import { randomUUID } from "crypto";
import sharp from "sharp";

import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/server";

import type {
  ImageSource,
  ImageSourcePref,
} from "@/lib/types";

const STORAGE_BUCKET = "post-images";

const GEMINI_IMAGE_MODEL =
  "gemini-3.1-flash-image";

const GEMINI_IMAGE_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const GEMINI_TIMEOUT_MS = 90_000;

const PEXELS_TIMEOUT_MS = 20_000;

// Final image size.
const FINAL_WIDTH = 1080;
const FINAL_HEIGHT = 1080;

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
  "no collage",
  "no grid",
].join(", ");

function buildGeminiPrompt(
  prompt: string,
  title?: string
): string {
  const headline =
    title?.trim() || "";

  return [
    "Create a high-quality square social media photograph.",

    "",

    "VISUAL CONCEPT:",
    prompt.trim(),

    "",

    "HEADLINE TEXT INSIDE THE IMAGE:",
    headline
      ? `"${headline}"`
      : "Create a short relevant headline based on the visual concept.",

    "",

    "TEXT OVERLAY REQUIREMENTS:",
    "- The headline MUST be visibly rendered inside the image.",
    "- Use the exact headline wording whenever possible.",
    "- The headline must be clearly readable on a mobile phone.",
    "- Use large, bold, professional typography.",
    "- Choose typography that matches the mood of the photograph.",
    "- Place the headline naturally within the composition.",
    "- Prefer the lower third or another area with sufficient negative space.",
    "- Do not cover the main subject or important facial features.",
    "- Use a subtle dark or light semi-transparent contrast box when necessary.",
    "- Use strong contrast between the headline and background.",
    "- Correct spelling is required.",
    "- Natural capitalization is required.",
    "- Do not add hashtags to the image.",
    "- Do not add URLs to the image.",
    "- Do not add logos.",
    "- Do not add watermarks.",
    "- Do not add unrelated text.",

    "",

    "VISUAL STYLE:",
    PHOTO_STYLE,

    "",

    "COMPOSITION:",
    "- 1:1 square composition.",
    "- Designed for a Facebook mobile feed.",
    "- Strong visual hierarchy.",
    "- Main subject should remain visually dominant.",
    "- Headline should be immediately noticeable but not overpower the photograph.",
    "- Professional viral social-media photography aesthetic.",
  ].join("\n");
}

// ============================================================
// PEXELS SEARCH QUERY
// ============================================================

function buildPexelsQuery(
  prompt: string
): string {
  let query = prompt
    .replace(
      /create|generate|image|photo|photograph|photorealistic|professional|high quality/gi,
      " "
    )
    .replace(
      /social media|square|natural lighting|realistic|high detail|clean composition/gi,
      " "
    )
    .replace(
      /no text|no watermark|no logo|no collage|no grid/gi,
      " "
    )
    .replace(
      /bold overlay text|overlay text|headline text|typography|font|contrast box/gi,
      " "
    )
    .replace(
      /[^a-zA-Z0-9À-ÿ\s-]/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  const words = query
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);

  if (words.length === 0) {
    return "lifestyle";
  }

  return words.join(" ");
}

// ============================================================
// GEMINI IMAGE GENERATION
// ============================================================

async function fetchGeminiImageBytes(
  prompt: string,
  title?: string
): Promise<Blob> {
  const apiKey =
    env.geminiApiKey;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }

  const finalPrompt =
    buildGeminiPrompt(
      prompt,
      title
    );

  console.info(
    `[IMAGE] Gemini starting model=${GEMINI_IMAGE_MODEL}`
  );

  console.info(
    `[IMAGE] Gemini headline="${title?.trim() || ""}"`
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

  // ==========================================================
  // PRIMARY: output_image.data
  // ==========================================================

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

  // ==========================================================
  // SECONDARY: steps[].content[]
  // ==========================================================

  const steps =
    Array.isArray(data?.steps)
      ? data.steps
      : [];

  for (const step of steps) {
    const content =
      Array.isArray(step?.content)
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
    Array.isArray(data?.photos)
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
// HEADLINE WRAPPING
// ============================================================

function wrapHeadline(
  title: string,
  maxChars = 20
): string[] {
  const words =
    title
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
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
        lines.push(current);
      }

      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  /*
   * Keep the overlay compact.
   * If there are more than 3 lines,
   * merge the remaining words into line 3.
   */
  if (lines.length > 3) {
    const first =
      lines[0];

    const second =
      lines[1];

    const remaining =
      lines
        .slice(2)
        .join(" ");

    return [
      first,
      second,
      remaining,
    ];
  }

  return lines;
}

// ============================================================
// HEADLINE SVG
// ============================================================

function createHeadlineSvg(
  title: string
): Buffer {
  const cleanTitle =
    title
      .trim()
      .replace(/\s+/g, " ");

  if (!cleanTitle) {
    throw new Error(
      "Headline title is empty"
    );
  }

  const lines =
    wrapHeadline(
      cleanTitle,
      22
    );

  if (lines.length === 0) {
    throw new Error(
      "Unable to create headline overlay"
    );
  }

  const fontSize =
    lines.length === 1
      ? 72
      : lines.length === 2
        ? 66
        : 58;

  const lineHeight =
    fontSize + 12;

  const boxPaddingX =
    42;

  const boxPaddingY =
    30;

  const boxWidth =
    FINAL_WIDTH -
    80;

  const textBlockHeight =
    lines.length *
      lineHeight;

  const boxHeight =
    textBlockHeight +
    boxPaddingY * 2;

  const boxX = 40;

  const boxY =
    FINAL_HEIGHT -
    boxHeight -
    55;

  const textStartY =
    boxY +
    boxPaddingY +
    fontSize;

  const escapedLines =
    lines.map(
      (line) =>
        `<tspan x="540" dy="${line === lines[0] ? 0 : lineHeight}">${escapeXml(
          line.toUpperCase()
        )}</tspan>`
    );

  const svg = `
<svg
  width="${FINAL_WIDTH}"
  height="${FINAL_HEIGHT}"
  viewBox="0 0 ${FINAL_WIDTH} ${FINAL_HEIGHT}"
  xmlns="http://www.w3.org/2000/svg"
>
  <defs>
    <filter
      id="shadow"
      x="-20%"
      y="-20%"
      width="140%"
      height="140%"
    >
      <feDropShadow
        dx="0"
        dy="3"
        stdDeviation="4"
        flood-color="#000000"
        flood-opacity="0.55"
      />
    </filter>
  </defs>

  <rect
    x="${boxX}"
    y="${boxY}"
    width="${boxWidth}"
    height="${boxHeight}"
    rx="28"
    fill="#000000"
    fill-opacity="0.68"
  />

  <text
    x="540"
    y="${textStartY}"
    text-anchor="middle"
    font-family="Arial, Helvetica, sans-serif"
    font-size="${fontSize}px"
    font-weight="900"
    fill="#ffffff"
    stroke="#000000"
    stroke-width="1"
    paint-order="stroke"
    filter="url(#shadow)"
  >
    ${escapedLines.join("\n    ")}
  </text>
</svg>
`;

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
  title?: string
): Promise<Blob> {
  const cleanTitle =
    title?.trim() || "";

  /*
   * If no title is supplied, preserve the original image.
   */
  if (!cleanTitle) {
    console.warn(
      "[IMAGE] No headline supplied; skipping text overlay."
    );

    return blob;
  }

  console.info(
    `[IMAGE] Applying headline overlay: "${cleanTitle}"`
  );

  const inputBuffer =
    Buffer.from(
      await blob.arrayBuffer()
    );

  const svgOverlay =
    createHeadlineSvg(
      cleanTitle
    );

  const outputBuffer =
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

  console.info(
    `[IMAGE] Headline overlay SUCCESS finalBytes=${outputBuffer.length}`
  );

  return new Blob(
    [outputBuffer],
    {
      type: "image/jpeg",
    }
  );
}

// ============================================================
// PUBLIC GENERATOR
// ============================================================

export async function generateImage(
  prompt: string,
  pref: ImageSourcePref,
  title?: string
): Promise<{
  url: string;
  source: ImageSource;
}> {
  const cleanPrompt =
    prompt.trim();

  const cleanTitle =
    title?.trim() || "";

  if (!cleanPrompt) {
    throw new Error(
      "Image prompt is required"
    );
  }

  const source =
    resolveImageSource(
      pref
    );

  console.info(
    `[IMAGE] requested source=${source}`
  );

  console.info(
    `[IMAGE] title="${cleanTitle}"`
  );

  // ==========================================================
  // AI SOURCE
  // Gemini -> Pexels
  // ==========================================================

  if (source === "ai") {
    try {
      const baseBlob =
        await fetchGeminiImageBytes(
          cleanPrompt,
          cleanTitle
        );

      /*
       * IMPORTANT:
       * Always apply the title AFTER Gemini generation.
       * This guarantees the text exists even when Gemini
       * failed to render it itself.
       */
      const finalBlob =
        await applyHeadlineOverlay(
          baseBlob,
          cleanTitle
        );

      return upload(
        finalBlob,
        "ai"
      );
    } catch (geminiError) {
      const message =
        geminiError instanceof Error
          ? geminiError.message
          : String(geminiError);

      console.error(
        `[IMAGE] Gemini FAILED: ${message}`
      );

      try {
        const baseBlob =
          await fetchStockImageBytes(
            cleanPrompt
          );

        /*
         * Pexels does not create text.
         * Sharp adds the headline here.
         */
        const finalBlob =
          await applyHeadlineOverlay(
            baseBlob,
            cleanTitle
          );

        return upload(
          finalBlob,
          "stock"
        );
      } catch (pexelsError) {
        const message2 =
          pexelsError instanceof Error
            ? pexelsError.message
            : String(pexelsError);

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
  // Pexels -> Gemini
  // ==========================================================

  try {
    const baseBlob =
      await fetchStockImageBytes(
        cleanPrompt
      );

    /*
     * IMPORTANT:
     * Pexels image also receives the same headline overlay.
     */
    const finalBlob =
      await applyHeadlineOverlay(
        baseBlob,
        cleanTitle
      );

    return upload(
      finalBlob,
      "stock"
    );
  } catch (pexelsError) {
    const message =
      pexelsError instanceof Error
        ? pexelsError.message
        : String(pexelsError);

    console.error(
      `[IMAGE] Pexels FAILED: ${message}`
    );

    try {
      const baseBlob =
        await fetchGeminiImageBytes(
          cleanPrompt,
          cleanTitle
        );

      /*
       * Gemini fallback also receives programmatic overlay.
       */
      const finalBlob =
        await applyHeadlineOverlay(
          baseBlob,
          cleanTitle
        );

      return upload(
        finalBlob,
        "ai"
      );
    } catch (geminiError) {
      const message2 =
        geminiError instanceof Error
          ? geminiError.message
          : String(geminiError);

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

  /*
   * applyHeadlineOverlay() outputs JPEG,
   * but this also safely handles other image types.
   */
  let extension =
    "jpg";

  if (
    blob.type ===
    "image/png"
  ) {
    extension = "png";
  } else if (
    blob.type ===
    "image/webp"
  ) {
    extension = "webp";
  }

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

  console.info(
    `[IMAGE] Supabase upload source=${source} path=${path} size=${bytes.length}`
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
            blob.type ||
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
      "Supabase did not return public image URL"
    );
  }

  console.info(
    `[IMAGE] Supabase upload SUCCESS source=${source} url=${data.publicUrl}`
  );

  return {
    url:
      data.publicUrl,

    source,
  };
}


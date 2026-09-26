import { randomUUID } from "crypto";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { ImageSource, ImageSourcePref } from "@/lib/types";

const STORAGE_BUCKET = "post-images";

const WIDTH = 1200;
const HEIGHT = 1200;

/**
 * AI = Gemini image generation
 * STOCK = Pexels
 *
 * mixed = randomly selects Gemini or Pexels.
 */
export function resolveImageSource(pref: ImageSourcePref): ImageSource {
  if (pref === "mixed") {
    return Math.random() < 0.5 ? "ai" : "stock";
  }

  return pref;
}

const PHOTO_STYLE =
  "single subject, professional photograph, natural light, " +
  "shallow depth of field, high detail, photorealistic, " +
  "no text, no watermark, no collage, no grid";

/**
 * Generate an image using Gemini 3.1 Flash Image.
 *
 * IMPORTANT:
 * Pollinations is intentionally NOT used.
 */
async function fetchGeminiImageBytes(
  prompt: string
): Promise<Blob> {
  const apiKey = env.geminiApiKey;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }

  const finalPrompt =
    `${prompt}. ${PHOTO_STYLE}. ` +
    "Create a single square social-media photograph.";

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: "gemini-3.1-flash-image",
        input: finalPrompt,
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "1:1",
          image_size: "1K",
        },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini image API ${response.status}: ${body.slice(0, 500)}`
    );
  }

  const data = JSON.parse(body);

  /**
   * Current Gemini Interactions API returns the generated image
   * in output_image.data.
   */
  const base64 =
    data?.output_image?.data;

  if (
    typeof base64 !== "string" ||
    !base64.trim()
  ) {
    /**
     * Defensive fallback for responses that expose the image
     * inside interaction steps.
     */
    const steps = Array.isArray(data?.steps)
      ? data.steps
      : [];

    for (const step of steps) {
      const content = Array.isArray(step?.content)
        ? step.content
        : [];

      for (const item of content) {
        if (
          item?.type === "image" &&
          typeof item?.data === "string"
        ) {
          const bytes = Buffer.from(
            item.data,
            "base64"
          );

          return new Blob(
            [bytes],
            {
              type:
                item.mime_type ||
                "image/jpeg",
            }
          );
        }
      }
    }

    throw new Error(
      "Gemini image API returned no image data"
    );
  }

  const bytes = Buffer.from(
    base64,
    "base64"
  );

  return new Blob(
    [bytes],
    {
      type:
        data?.output_image?.mime_type ||
        "image/jpeg",
    }
  );
}

/**
 * Pexels stock-image fallback.
 */
async function fetchStockImageBytes(
  query: string
): Promise<Blob> {
  if (!env.pexelsApiKey) {
    throw new Error(
      "PEXELS_API_KEY is not configured"
    );
  }

  const searchUrl =
    `https://api.pexels.com/v1/search?` +
    new URLSearchParams({
      query,
      orientation: "square",
      per_page: "10",
    });

  const searchRes = await fetch(
    searchUrl,
    {
      headers: {
        Authorization: env.pexelsApiKey,
      },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!searchRes.ok) {
    throw new Error(
      `Pexels search failed (${searchRes.status})`
    );
  }

  const data = await searchRes.json();

  const photos: Array<{
    src: {
      large2x?: string;
      large: string;
    };
  }> = data.photos ?? [];

  if (photos.length === 0) {
    throw new Error(
      "No stock photos found for this topic"
    );
  }

  const chosen =
    photos[
      Math.floor(
        Math.random() * photos.length
      )
    ];

  const imageUrl =
    chosen.src.large2x ??
    chosen.src.large;

  const imageRes = await fetch(
    imageUrl,
    {
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!imageRes.ok) {
    throw new Error(
      "Failed to download chosen stock photo"
    );
  }

  return imageRes.blob();
}

/**
 * Generate or source an image and upload it to Supabase Storage.
 *
 * Priority:
 *
 * AI:
 *   Gemini
 *     ↓ failure
 *   Pexels
 *
 * STOCK:
 *   Pexels
 *     ↓ failure
 *   Gemini
 */
export async function generateImage(
  prompt: string,
  pref: ImageSourcePref
): Promise<{
  url: string;
  source: ImageSource;
}> {
  const source =
    resolveImageSource(pref);

  let blob: Blob;

  try {
    blob =
      source === "ai"
        ? await fetchGeminiImageBytes(prompt)
        : await fetchStockImageBytes(prompt);
  } catch (err) {
    console.error(
      `[generateImage] ${source} provider failed:`,
      err instanceof Error
        ? err.message
        : String(err)
    );

    /**
     * Fallback:
     *
     * Gemini -> Pexels
     * Pexels -> Gemini
     */
    const fallbackSource: ImageSource =
      source === "ai"
        ? "stock"
        : "ai";

    try {
      blob =
        fallbackSource === "ai"
          ? await fetchGeminiImageBytes(prompt)
          : await fetchStockImageBytes(prompt);

      return await upload(
        blob,
        fallbackSource
      );
    } catch (fallbackErr) {
      console.error(
        `[generateImage] fallback ${fallbackSource} failed:`,
        fallbackErr instanceof Error
          ? fallbackErr.message
          : String(fallbackErr)
      );

      throw new Error(
        `Image generation failed. Primary provider: ${source}. ` +
          `Fallback provider: ${fallbackSource}.`
      );
    }
  }

  return upload(
    blob,
    source
  );
}

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
    blob.type === "image/png"
      ? "png"
      : "jpg";

  const path =
    `${new Date().toISOString().slice(0, 10)}/` +
    `${randomUUID()}.${extension}`;

  const bytes =
    new Uint8Array(
      await blob.arrayBuffer()
    );

  const {
    error,
  } = await db.storage
    .from(STORAGE_BUCKET)
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
      `Storage upload failed: ${error.message}`
    );
  }

  const {
    data,
  } = db.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(path);

  return {
    url: data.publicUrl,
    source,
  };
}


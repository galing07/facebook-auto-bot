import { randomUUID } from "crypto";

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

```
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
"- Choose a font style that matches the mood of the photograph.",
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
```

].join("\n");
}

// ============================================================
// PEXELS SEARCH QUERY
// ============================================================

/**

* Pexels should NOT receive the entire AI prompt.
*
* Convert:
*
* "Create a photorealistic professional..."
*
* into a short search query:
*
* "wedding couple beach"
  */
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
const apiKey = env.geminiApiKey;

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
model: GEMINI_IMAGE_MODEL,

```
/*
 * Use the documented Interactions input format.
 */
input: [
  {
    type: "text",
    text: finalPrompt,
  },
],

/*
 * Request image output.
 */
response_format: {
  type: "image",
  mime_type: "image/jpeg",
  aspect_ratio: "1:1",
  image_size: "1K",
},
```

};

const response = await fetch(
GEMINI_IMAGE_ENDPOINT,
{
method: "POST",

```
  headers: {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  },

  body: JSON.stringify(
    requestBody
  ),

  signal:
    AbortSignal.timeout(
      GEMINI_TIMEOUT_MS
    ),
}
```

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

```
throw new Error(
  `Gemini image API HTTP ${response.status}: ${body.slice(
    0,
    500
  )}`
);
```

}

let data: any;

try {
data = JSON.parse(body);
} catch {
console.error(
"[IMAGE] Gemini returned non-JSON:",
body.slice(0, 1000)
);

```
throw new Error(
  "Gemini returned invalid JSON"
);
```

}

// ==========================================================
// PRIMARY: output_image.data
// ==========================================================

const outputImage =
data?.output_image;

if (
outputImage &&
typeof outputImage.data === "string" &&
outputImage.data.length > 0
) {
const mimeType =
typeof outputImage.mime_type === "string"
? outputImage.mime_type
: "image/jpeg";

```
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
```

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

```
for (const item of content) {
  if (
    item?.type === "image" &&
    typeof item?.data === "string" &&
    item.data.length > 0
  ) {
    const mimeType =
      typeof item.mime_type === "string"
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
```

}

// ==========================================================
// NO IMAGE
// ==========================================================

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
buildPexelsQuery(prompt);

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

```
    headers: {
      Authorization: apiKey,
    },

    signal:
      AbortSignal.timeout(
        PEXELS_TIMEOUT_MS
      ),
  }
);
```

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

```
throw new Error(
  `Pexels HTTP ${response.status}: ${body.slice(
    0,
    500
  )}`
);
```

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
`[IMAGE] Pexels downloading selected photo`
);

const imageResponse =
await fetch(
imageUrl,
{
method: "GET",

```
    signal:
      AbortSignal.timeout(
        PEXELS_TIMEOUT_MS
      ),
  }
);
```

if (!imageResponse.ok) {
throw new Error(
`Pexels image download HTTP ${imageResponse.status}`
);
}

const blob =
await imageResponse.blob();

if (
!blob.type ||
!blob.type.startsWith("image/")
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
resolveImageSource(pref);

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
const blob =
await fetchGeminiImageBytes(
cleanPrompt,
cleanTitle
);

```
  return upload(
    blob,
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
    const blob =
      await fetchStockImageBytes(
        cleanPrompt
      );

    return upload(
      blob,
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
```

}

// ==========================================================
// STOCK SOURCE
// Pexels -> Gemini
// ==========================================================

try {
const blob =
await fetchStockImageBytes(
cleanPrompt
);

```
return upload(
  blob,
  "stock"
);
```

} catch (pexelsError) {
const message =
pexelsError instanceof Error
? pexelsError.message
: String(pexelsError);

```
console.error(
  `[IMAGE] Pexels FAILED: ${message}`
);

try {
  const blob =
    await fetchGeminiImageBytes(
      cleanPrompt,
      cleanTitle
    );

  return upload(
    blob,
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
```

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

let extension = "jpg";

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
.from(STORAGE_BUCKET)
.upload(
path,
bytes,
{
contentType:
blob.type ||
"image/jpeg",

```
      upsert: false,
    }
  );
```

if (error) {
throw new Error(
`Supabase Storage upload failed: ${error.message}`
);
}

const {
data,
} =
db.storage
.from(STORAGE_BUCKET)
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
`[IMAGE] Supabase upload SUCCESS source=${source}`
);

return {
url:
data.publicUrl,

```
source,
```

};
}

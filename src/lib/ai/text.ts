import { env } from "@/lib/env";
import type { ContentProvider, GeneratedContent } from "@/lib/types";

const SYSTEM_PROMPT = `You are an expert Facebook Page copywriter and viral social media content strategist.

Given a topic, create ONE engaging Facebook photo post and a matching AI image prompt.

Return STRICT JSON with exactly this shape and nothing else:
{
  "title": string,
  "description": string,
  "hashtags": string[],
  "imagePrompt": string
}

The title, description and hashtags together form ONE complete Facebook caption.

Rules:

TITLE:
- Opening hook that immediately attracts attention.
- <= 80 characters.
- Conversational, emotional and scroll-stopping.
- Specific to the topic.
- At most one emoji.
- No hashtags.
- Avoid fake claims or misleading clickbait.

DESCRIPTION:
- 2-4 short sentences.
- <= 400 characters.
- Easy to read on a mobile phone.
- Natural conversational language.
- Create curiosity and emotional engagement.
- Do not use generic marketing clichés.
- Do not repeat the title.
- End with a question or soft call-to-action that encourages comments.
- Stay factually reasonable and do not invent specific facts.

HASHTAGS:
- 3 to 5 highly relevant hashtags.
- Lowercase.
- No "#" symbol.
- No spaces inside a hashtag.
- Mix broad and specific hashtags when appropriate.

IMAGEPROMPT:
- Write a detailed image-generation prompt in ENGLISH.
- The image must directly match the title and description.
- Describe the main subject, environment, composition, lighting, atmosphere, camera/photo style and important visual details.
- Make it visually striking and suitable for a Facebook viral photo post.
- Prefer realistic photography unless the topic clearly requires another style.
- Use cinematic composition and natural lighting when appropriate.
- Square composition suitable for social media.
- Do NOT include text, captions, logos, watermarks or UI elements inside the image.
- Do not describe fake screenshots or social media interfaces.
- The image should communicate the story visually without requiring text.

IMPORTANT:
- The caption and image must tell the SAME story.
- Do not create an unrelated image.
- Output ONLY the JSON object.
- No markdown fences.
- No commentary.`;

const TIMEOUT_MS = 20_000;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object in response");
  }

  return JSON.parse(text.slice(start, end + 1));
}

function parseContent(raw: string): GeneratedContent {
  const parsed = extractJson(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Malformed generation payload");
  }

  const o = parsed as Record<string, unknown>;

  if (
    typeof o.title !== "string" ||
    typeof o.description !== "string" ||
    !Array.isArray(o.hashtags) ||
    !o.hashtags.every((h) => typeof h === "string") ||
    typeof o.imagePrompt !== "string"
  ) {
    throw new Error("Malformed generation payload");
  }

  const imagePrompt = o.imagePrompt.trim();

  if (!imagePrompt) {
    throw new Error("AI returned an empty imagePrompt");
  }

  return {
    title: o.title.trim(),
    description: o.description.trim(),
    hashtags: (o.hashtags as string[])
      .map((h) => h.replace(/^#/, "").trim())
      .filter(Boolean),
    imagePrompt,
  };
}

/**
 * OpenAI-compatible chat completion.
 *
 * Used for Groq only.
 */
async function groqCompletion(
  model: string,
  topic: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: `Topic: ${topic}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  const body = await res.text();

  if (!res.ok) {
    throw new Error(
      `Groq ${model} responded ${res.status}: ${body.slice(0, 300)}`
    );
  }

  const data = JSON.parse(body);

  if (data?.error) {
    const message =
      typeof data.error === "string"
        ? data.error
        : data.error?.message;

    throw new Error(
      `Groq ${model}: ${message ?? "unknown error"}`
    );
  }

  const content: unknown =
    data?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`Groq ${model}: empty completion`);
  }

  return content;
}

/**
 * Gemini text fallback.
 */
async function geminiCompletion(
  topic: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `Topic: ${topic}` }],
          },
        ],
        generationConfig: {
          temperature: 0.9,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  const body = await res.text();

  if (!res.ok) {
    throw new Error(
      `Gemini responded ${res.status}: ${body.slice(0, 300)}`
    );
  }

  const data = JSON.parse(body);

  const content: unknown =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Gemini returned empty completion");
  }

  return content;
}

/**
 * Local fallback.
 *
 * Used only when Groq and Gemini are unavailable or fail.
 */
function template(topic: string): GeneratedContent {
  const clean = topic.trim();

  const words = clean
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  return {
    title: `${clean} — worth a look today`,
    description:
      `We put together a few ideas around ${clean.toLowerCase()}. ` +
      `Simple things you can actually explore today. ` +
      `What do you think about it?`,
    hashtags: [...new Set(words)]
      .concat(["ideas"])
      .slice(0, 5),
    imagePrompt:
      `A realistic cinematic photograph related to ${clean}, ` +
      `visually compelling composition, natural lighting, ` +
      `high detail, realistic photography, square composition, ` +
      `no text, no logo, no watermark.`,
  };
}

type Attempt = {
  provider: ContentProvider;
  model?: string;
  run: () => Promise<string>;
};

function providerChain(topic: string): Attempt[] {
  const chain: Attempt[] = [];

  const groqKey = env.groqApiKey;

  if (groqKey) {
    /**
     * Groq production models.
     *
     * GPT OSS 120B is the primary model.
     * GPT OSS 20B is the smaller fallback.
     */
    const models = [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ];

    for (const model of models) {
      chain.push({
        provider: "groq",
        model,
        run: () => groqCompletion(model, topic, groqKey),
      });
    }
  }

  /**
   * Gemini is a text fallback.
   */
  const geminiKey = env.geminiApiKey;

  if (geminiKey) {
    chain.push({
      provider: "gemini",
      run: () => geminiCompletion(topic, geminiKey),
    });
  }

  /**
   * Pollinations has intentionally been removed.
   */
  return chain;
}

export async function generateContent(
  topic: string
): Promise<GeneratedContent> {
  const failures: string[] = [];

  const chain = providerChain(topic);

  if (chain.length === 0) {
    return {
      ...template(topic),
      provider: "template",
      providerError:
        "No AI provider configured. Add GROQ_API_KEY or GEMINI_API_KEY.",
    };
  }

  for (const { provider, model, run } of chain) {
    try {
      const raw = await run();

      const parsed = parseContent(raw);

      console.info(
        `[generateContent] provider=${provider}` +
          `${model ? ` model=${model}` : ""}`
      );

      console.info(
        `[generateContent] imagePrompt generated=${Boolean(
          parsed.imagePrompt
        )}`
      );

      return {
        ...parsed,
        provider,
      };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : String(err);

      failures.push(
        `${provider}${model ? `/${model}` : ""}: ${message}`
      );

      console.error(
        `[generateContent] ${provider}` +
          `${model ? `/${model}` : ""} failed:`,
        message
      );
    }
  }

  console.error(
    "[generateContent] every configured AI provider failed:",
    failures.join(" | ")
  );

  return {
    ...template(topic),
    provider: "template",
    providerError: failures.join(" | "),
  };
}


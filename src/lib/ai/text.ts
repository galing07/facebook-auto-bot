```ts
import { env } from "@/lib/env";
import type { ContentProvider, GeneratedContent } from "@/lib/types";

const SYSTEM_PROMPT = `You are an expert Facebook Page copywriter. Given a topic, write a single
high-performing Facebook photo post in strict JSON with this exact shape and nothing else:
{"title": string, "description": string, "hashtags": string[]}

The three parts are joined into one caption, in that order, so they must read as
one post rather than three fragments.

Rules:
- title: the opening hook, <= 80 characters. Conversational, scroll-stopping, specific. At most one emoji. No hashtags.
- description: 2-4 short sentences, <= 400 characters, written to be read on a phone. Plain language, no marketing cliches. End with a question or a soft call to action that invites comments.
- hashtags: 3 to 5 short, highly relevant hashtags, lowercase, no "#" symbol, no spaces.
- Output ONLY the JSON object. No markdown fences, no commentary.`;

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
    !o.hashtags.every((h) => typeof h === "string")
  ) {
    throw new Error("Malformed generation payload");
  }

  return {
    title: o.title.trim(),
    description: o.description.trim(),
    hashtags: (o.hashtags as string[])
      .map((h) => h.replace(/^#/, "").trim())
      .filter(Boolean),
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
    throw new Error(`Groq ${model} responded ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = JSON.parse(body);

  if (data?.error) {
    const message =
      typeof data.error === "string"
        ? data.error
        : data.error?.message;

    throw new Error(`Groq ${model}: ${message ?? "unknown error"}`);
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
    throw new Error(`Gemini responded ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = JSON.parse(body);

  const content: unknown =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Gemini returned empty completion");
  }

  return content;
}

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
      `Simple things you can actually try this week. ` +
      `Which one would you start with?`,
    hashtags: [...new Set(words)]
      .concat(["ideas"])
      .slice(0, 5),
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
     * Current Groq production models.
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
   * Gemini is a text fallback only.
   */
  const geminiKey = env.geminiApiKey;

  if (geminiKey) {
    chain.push({
      provider: "gemini",
      run: () => geminiCompletion(topic, geminiKey),
    });
  }

  /**
   * IMPORTANT:
   * Pollinations has intentionally been removed.
   *
   * If Groq and Gemini fail, return a deterministic template instead
   * of silently using another external AI provider.
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
```

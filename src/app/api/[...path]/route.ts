import { NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { generateContent } from "@/lib/ai/text";
import { generateImage } from "@/lib/ai/image";

import {
  getSettings,
  updateSettings,
} from "@/lib/db/settings";

import {
  getPosts,
  getPost,
  createPost,
  updatePostRecord,
  deletePost,
} from "@/lib/db/posts";

import {
  getTopics,
  createTopic,
  updateTopic,
  deleteTopic,
} from "@/lib/db/topics";

import {
  getFacebookPages,
  getFacebookOAuthUrl,
  handleFacebookOAuthCallback,
  getFacebookPageToken,
} from "@/lib/facebook/oauth";

import {
  publishPostNow,
} from "@/lib/facebook/publish";

import {
  processAutoPost,
} from "@/lib/cron";

import {
  getSession,
  createSession,
  destroySession,
} from "@/lib/auth/session";

import type {
  AppSettings,
  ImageSourcePref,
  PostStatus,
  TopicSource,
} from "@/lib/types";

export const maxDuration = 60;

// ============================================================
// RESPONSE HELPERS
// ============================================================

function json(
  data: unknown,
  status = 200
) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function errorMessage(
  err: unknown,
  fallback = "Internal server error."
): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === "string") {
    return err;
  }

  return fallback;
}

// ============================================================
// ZOD SCHEMAS
// ============================================================

const LoginBody = z.object({
  password: z.string().min(1),
});

const ContentBody = z.object({
  topic: z
    .string()
    .trim()
    .min(2)
    .max(200),
});

const ImageBody = z.object({
  prompt: z
    .string()
    .trim()
    .min(2)
    .max(300),

  /*
   * REQUIRED:
   * This is the exact Facebook headline that must appear
   * inside the final generated image.
   */
  title: z
    .string()
    .trim()
    .min(1)
    .max(120),

  source: z.enum([
    "ai",
    "stock",
    "mixed",
  ]),
});

const CreatePostBody = z.object({
  topic: z
    .string()
    .min(1)
    .max(200),

  title: z
    .string()
    .min(1)
    .max(120),

  description: z
    .string()
    .min(1)
    .max(500),

  hashtags: z
    .array(z.string())
    .max(15)
    .default([]),

  imageUrl: z
    .string()
    .url(),

  imageSource: z.enum([
    "ai",
    "stock",
  ]),

  linkUrl: z
    .string()
    .url()
    .optional()
    .or(z.literal("")),

  pageId: z
    .string()
    .min(1),

  pageName: z
    .string()
    .min(1),

  action: z.enum([
    "draft",
    "schedule",
    "post_now",
  ]),

  scheduledAt: z
    .string()
    .datetime()
    .optional(),
});

const UpdateSettingsBody = z.object({
  default_page_id: z
    .string()
    .nullable()
    .optional(),

  default_page_name: z
    .string()
    .nullable()
    .optional(),

  default_page_token: z
    .string()
    .nullable()
    .optional(),

  image_source: z
    .enum([
      "ai",
      "stock",
      "mixed",
    ])
    .optional(),

  utm_suffix: z
    .string()
    .optional(),

  auto_post_enabled: z
    .boolean()
    .optional(),

  posts_per_day: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional(),

  posting_hours: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(23)
    )
    .optional(),

  timezone: z
    .string()
    .optional(),

  topic_source: z
    .enum([
      "mine",
      "trending",
      "mixed",
    ])
    .optional(),
});

const CreateTopicBody = z.object({
  text: z
    .string()
    .trim()
    .min(2)
    .max(200),
});

const UpdateTopicBody = z.object({
  text: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .optional(),

  enabled: z
    .boolean()
    .optional(),
});

const FacebookCredentialsBody = z.object({
  appId: z
    .string()
    .trim()
    .optional(),

  appSecret: z
    .string()
    .trim()
    .optional(),

  configId: z
    .string()
    .trim()
    .optional(),
});

// ============================================================
// ROUTE HELPERS
// ============================================================

function getRoute(
  req: NextRequest
): string {
  const pathname =
    new URL(req.url).pathname;

  const prefix =
    "/api/";

  if (!pathname.startsWith(prefix)) {
    return "";
  }

  return pathname
    .slice(prefix.length)
    .replace(/^\/+|\/+$/g, "");
}

function getIdFromRoute(
  route: string,
  prefix: string
): string | null {
  if (!route.startsWith(prefix)) {
    return null;
  }

  const id =
    route.slice(prefix.length);

  return id || null;
}

// ============================================================
// AUTH
// ============================================================

const OPEN_ROUTES = new Set([
  "auth/login",
  "auth/logout",
  "facebook/oauth/callback",
]);

async function requireAuth(
  req: NextRequest,
  route: string
): Promise<Response | null> {
  if (OPEN_ROUTES.has(route)) {
    return null;
  }

  /*
   * Cron requests use CRON_SECRET instead of the dashboard
   * session cookie.
   */
  if (route === "cron") {
    const configuredSecret =
      env.cronSecret;

    if (configuredSecret) {
      const authHeader =
        req.headers.get(
          "authorization"
        );

      const expected =
        `Bearer ${configuredSecret}`;

      if (authHeader === expected) {
        return null;
      }
    }
  }

  const session =
    await getSession(req);

  if (!session) {
    return json(
      {
        error: "Unauthorized.",
      },
      401
    );
  }

  return null;
}

// ============================================================
// GET
// ============================================================

async function handleGet(
  req: NextRequest,
  route: string
): Promise<Response> {
  // ----------------------------------------------------------
  // SETTINGS
  // ----------------------------------------------------------

  if (route === "settings") {
    const settings =
      await getSettings();

    return json(settings);
  }

  // ----------------------------------------------------------
  // POSTS
  // ----------------------------------------------------------

  if (route === "posts") {
    const posts =
      await getPosts();

    return json(posts);
  }

  // ----------------------------------------------------------
  // SINGLE POST
  // ----------------------------------------------------------

  const postId =
    getIdFromRoute(
      route,
      "posts/"
    );

  if (
    postId &&
    route === `posts/${postId}`
  ) {
    const post =
      await getPost(postId);

    if (!post) {
      return json(
        {
          error: "Post not found.",
        },
        404
      );
    }

    return json(post);
  }

  // ----------------------------------------------------------
  // TOPICS
  // ----------------------------------------------------------

  if (route === "topics") {
    const topics =
      await getTopics();

    return json(topics);
  }

  // ----------------------------------------------------------
  // FACEBOOK PAGES
  // ----------------------------------------------------------

  if (route === "facebook/pages") {
    const pages =
      await getFacebookPages();

    return json(pages);
  }

  // ----------------------------------------------------------
  // FACEBOOK OAUTH URL
  // ----------------------------------------------------------

  if (
    route ===
    "facebook/oauth/start"
  ) {
    const url =
      await getFacebookOAuthUrl();

    return json({
      url,
    });
  }

  // ----------------------------------------------------------
  // FACEBOOK OAUTH CALLBACK
  // ----------------------------------------------------------

  if (
    route ===
    "facebook/oauth/callback"
  ) {
    return json({
      error:
        "OAuth callback must use GET.",
    }, 405);
  }

  // ----------------------------------------------------------
  // HEALTH
  // ----------------------------------------------------------

  if (route === "health") {
    return json({
      ok: true,
      timestamp:
        new Date().toISOString(),
    });
  }

  return json(
    {
      error: "Route not found.",
    },
    404
  );
}

// ============================================================
// POST
// ============================================================

async function handlePost(
  req: NextRequest,
  route: string
): Promise<Response> {
  // ----------------------------------------------------------
  // LOGIN
  // ----------------------------------------------------------

  if (route === "auth/login") {
    const body =
      await req
        .json()
        .catch(() => null);

    const parsed =
      LoginBody.safeParse(body);

    if (!parsed.success) {
      return json(
        {
          error:
            "Password is required.",
        },
        400
      );
    }

    if (
      parsed.data.password !==
      env.adminPassword
    ) {
      return json(
        {
          error:
            "Invalid password.",
        },
        401
      );
    }

    const session =
      await createSession();

    const response =
      json({
        ok: true,
      });

    /*
     * createSession() is expected to handle the cookie
     * when implemented by the project's session helper.
     */
    return response;
  }

  // ----------------------------------------------------------
  // LOGOUT
  // ----------------------------------------------------------

  if (route === "auth/logout") {
    await destroySession();

    return json({
      ok: true,
    });
  }

  // ----------------------------------------------------------
  // GENERATE CONTENT
  // ----------------------------------------------------------

  if (
    route ===
    "generate/content"
  ) {
    const parsed =
      ContentBody.safeParse(
        await req
          .json()
          .catch(() => null)
      );

    if (!parsed.success) {
      return json(
        {
          error:
            "A topic is required.",
        },
        400
      );
    }

    try {
      const content =
        await generateContent(
          parsed.data.topic
        );

      return json(content);
    } catch (err) {
      console.error(
        "[API] Content generation failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Content generation failed."
            ),
        },
        502
      );
    }
  }

  // ----------------------------------------------------------
  // GENERATE IMAGE
  //
  // IMPORTANT:
  // title is forwarded to generateImage() so the AI image
  // generator knows the exact Facebook headline that must
  // appear inside the generated image.
  // ----------------------------------------------------------

  if (
    route ===
    "generate/image"
  ) {
    const parsed =
      ImageBody.safeParse(
        await req
          .json()
          .catch(() => null)
      );

    if (!parsed.success) {
      return json(
        {
          error:
            "An image prompt and image source are required.",
        },
        400
      );
    }

    try {
      console.info(
        "[API] Image generation request:",
        {
          source:
            parsed.data.source,

          title:
            parsed.data.title ??
            "(no title)",

          promptLength:
            parsed.data.prompt.length,
        }
      );

      const result =
        await generateImage(
          parsed.data.prompt,
          parsed.data.source,
          parsed.data.title
        );

      return json(result);
    } catch (err) {
      console.error(
        "[API] Image generation failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Image generation failed."
            ),
        },
        502
      );
    }
  }

  // ----------------------------------------------------------
  // CREATE POST
  // ----------------------------------------------------------

  if (route === "posts") {
    const parsed =
      CreatePostBody.safeParse(
        await req
          .json()
          .catch(() => null)
      );

    if (!parsed.success) {
      return json(
        {
          error:
            "Invalid post data.",
          details:
            parsed.error.flatten(),
        },
        400
      );
    }

    const data =
      parsed.data;

    let status:
      | PostStatus =
      "draft";

    if (
      data.action ===
      "schedule"
    ) {
      status = "scheduled";
    }

    if (
      data.action ===
      "post_now"
    ) {
      status = "draft";
    }

    try {
      const post =
        await createPost({
          topic:
            data.topic,

          title:
            data.title,

          description:
            data.description,

          hashtags:
            data.hashtags,

          image_url:
            data.imageUrl,

          image_source:
            data.imageSource,

          link_url:
            data.linkUrl || null,

          page_id:
            data.pageId,

          page_name:
            data.pageName,

          status,

          scheduled_at:
            data.scheduledAt ??
            null,

          posted_at:
            null,

          facebook_post_id:
            null,

          error_message:
            null,
        });

      /*
       * post_now creates the record first, then publishes it.
       * This guarantees that the generated image URL is already
       * stored before Facebook is contacted.
       */
      if (
        data.action ===
        "post_now"
      ) {
        const published =
          await publishPostNow(
            post.id
          );

        return json(
          published
        );
      }

      return json(
        post,
        201
      );
    } catch (err) {
      console.error(
        "[API] Create post failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to create post."
            ),
        },
        500
      );
    }
  }

  // ----------------------------------------------------------
  // CREATE TOPIC
  // ----------------------------------------------------------

  if (route === "topics") {
    const parsed =
      CreateTopicBody.safeParse(
        await req
          .json()
          .catch(() => null)
      );

    if (!parsed.success) {
      return json(
        {
          error:
            "Topic text is required.",
        },
        400
      );
    }

    try {
      const topic =
        await createTopic(
          parsed.data.text
        );

      return json(
        topic,
        201
      );
    } catch (err) {
      console.error(
        "[API] Create topic failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to create topic."
            ),
        },
        500
      );
    }
  }

  // ----------------------------------------------------------
  // POST NOW
  // ----------------------------------------------------------

  const postNowId =
    getIdFromRoute(
      route,
      "posts/"
    );

  if (
    postNowId &&
    route ===
      `posts/${postNowId}/post-now`
  ) {
    try {
      const post =
        await publishPostNow(
          postNowId
        );

      return json(post);
    } catch (err) {
      console.error(
        "[API] Post now failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to publish post."
            ),
        },
        500
      );
    }
  }

  // ----------------------------------------------------------
  // FACEBOOK DEFAULT PAGE
  // ----------------------------------------------------------

  if (
    route ===
    "facebook/default-page"
  ) {
    const body =
      await req
        .json()
        .catch(() => null);

    const pageId =
      typeof body?.pageId ===
      "string"
        ? body.pageId
        : "";

    const pageName =
      typeof body?.pageName ===
      "string"
        ? body.pageName
        : "";

    const pageToken =
      typeof body?.pageToken ===
      "string"
        ? body.pageToken
        : "";

    if (
      !pageId ||
      !pageName ||
      !pageToken
    ) {
      return json(
        {
          error:
            "pageId, pageName and pageToken are required.",
        },
        400
      );
    }

    const updated =
      await updateSettings({
        default_page_id:
          pageId,

        default_page_name:
          pageName,

        default_page_token:
          pageToken,
      });

    return json(updated);
  }

  // ----------------------------------------------------------
  // FACEBOOK CREDENTIALS
  // ----------------------------------------------------------

  if (
    route ===
    "facebook/credentials"
  ) {
    const parsed =
      FacebookCredentialsBody.safeParse(
        await req
          .json()
          .catch(() => null)
      );

    if (!parsed.success) {
      return json(
        {
          error:
            "Invalid Facebook credentials.",
        },
        400
      );
    }

    const updated =
      await updateSettings({
        facebook_app_id:
          parsed.data.appId ||
          null,

        facebook_app_secret:
          parsed.data.appSecret ||
          null,

        facebook_config_id:
          parsed.data.configId ||
          null,
      });

    return json(updated);
  }

  // ----------------------------------------------------------
  // FACEBOOK DISCONNECT
  // ----------------------------------------------------------

  if (
    route ===
    "facebook/disconnect"
  ) {
    const updated =
      await updateSettings({
        facebook_user_token:
          null,

        facebook_token_expires_at:
          null,

        facebook_user_name:
          null,

        default_page_id:
          null,

        default_page_name:
          null,

        default_page_token:
          null,
      });

    return json(updated);
  }

  // ----------------------------------------------------------
  // CRON
  // ----------------------------------------------------------

  if (route === "cron") {
    try {
      const result =
        await processAutoPost();

      return json(result);
    } catch (err) {
      console.error(
        "[API] Cron failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Cron execution failed."
            ),
        },
        500
      );
    }
  }

  return json(
    {
      error:
        "Route not found.",
    },
    404
  );
}

// ============================================================
// PATCH
// ============================================================

async function handlePatch(
  req: NextRequest,
  route: string
): Promise<Response> {
  // ----------------------------------------------------------
  // SETTINGS
  // ----------------------------------------------------------

  if (route === "settings") {
    const parsed =
      UpdateSettingsBody.safeParse(
        await req
          .json()
          .catch(() => null)
      );

    if (!parsed.success) {
      return json(
        {
          error:
            "Invalid settings.",
          details:
            parsed.error.flatten(),
        },
        400
      );
    }

    try {
      const updated =
        await updateSettings(
          parsed.data
        );

      return json(updated);
    } catch (err) {
      console.error(
        "[API] Update settings failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to update settings."
            ),
        },
        500
      );
    }
  }

  // ----------------------------------------------------------
  // TOPIC
  // ----------------------------------------------------------

  const topicId =
    getIdFromRoute(
      route,
      "topics/"
    );

  if (
    topicId &&
    route ===
      `topics/${topicId}`
  ) {
    const parsed =
      UpdateTopicBody.safeParse(
        await req
          .json()
          .catch(() => null)
      );

    if (!parsed.success) {
      return json(
        {
          error:
            "Invalid topic data.",
        },
        400
      );
    }

    try {
      const updated =
        await updateTopic(
          topicId,
          parsed.data
        );

      return json(updated);
    } catch (err) {
      console.error(
        "[API] Update topic failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to update topic."
            ),
        },
        500
      );
    }
  }

  // ----------------------------------------------------------
  // POST
  // ----------------------------------------------------------

  const postId =
    getIdFromRoute(
      route,
      "posts/"
    );

  if (
    postId &&
    route ===
      `posts/${postId}`
  ) {
    const body =
      await req
        .json()
        .catch(() => null);

    if (!body || typeof body !== "object") {
      return json(
        {
          error:
            "Invalid post data.",
        },
        400
      );
    }

    try {
      const updated =
        await updatePostRecord(
          postId,
          body as Partial<{
            title: string;
            description: string;
            hashtags: string[];
            link_url: string | null;
            page_id: string | null;
            page_name: string | null;
            status: PostStatus;
            scheduled_at: string | null;
            error_message: string | null;
          }>
        );

      return json(updated);
    } catch (err) {
      console.error(
        "[API] Update post failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to update post."
            ),
        },
        500
      );
    }
  }

  return json(
    {
      error:
        "Route not found.",
    },
    404
  );
}

// ============================================================
// DELETE
// ============================================================

async function handleDelete(
  req: NextRequest,
  route: string
): Promise<Response> {
  // ----------------------------------------------------------
  // POST
  // ----------------------------------------------------------

  const postId =
    getIdFromRoute(
      route,
      "posts/"
    );

  if (
    postId &&
    route ===
      `posts/${postId}`
  ) {
    try {
      await deletePost(
        postId
      );

      return json({
        ok: true,
      });
    } catch (err) {
      console.error(
        "[API] Delete post failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to delete post."
            ),
        },
        500
      );
    }
  }

  // ----------------------------------------------------------
  // TOPIC
  // ----------------------------------------------------------

  const topicId =
    getIdFromRoute(
      route,
      "topics/"
    );

  if (
    topicId &&
    route ===
      `topics/${topicId}`
  ) {
    try {
      await deleteTopic(
        topicId
      );

      return json({
        ok: true,
      });
    } catch (err) {
      console.error(
        "[API] Delete topic failed:",
        err
      );

      return json(
        {
          error:
            errorMessage(
              err,
              "Failed to delete topic."
            ),
        },
        500
      );
    }
  }

  return json(
    {
      error:
        "Route not found.",
    },
    404
  );
}

// ============================================================
// FACEBOOK OAUTH CALLBACK
// ============================================================

async function handleFacebookOAuthCallback(
  req: NextRequest
): Promise<Response> {
  try {
    const url =
      new URL(req.url);

    const code =
      url.searchParams.get(
        "code"
      );

    const state =
      url.searchParams.get(
        "state"
      );

    const error =
      url.searchParams.get(
        "error"
      );

    const errorDescription =
      url.searchParams.get(
        "error_description"
      );

    if (error) {
      return json(
        {
          error,
          error_description:
            errorDescription,
        },
        400
      );
    }

    if (!code) {
      return json(
        {
          error:
            "Missing OAuth code.",
        },
        400
      );
    }

    const result =
      await handleFacebookOAuthCallback(
        {
          code,
          state,
          requestUrl:
            req.url,
        }
      );

    return json(result);
  } catch (err) {
    console.error(
      "[API] Facebook OAuth callback failed:",
      err
    );

    return json(
      {
        error:
          errorMessage(
            err,
            "Facebook OAuth callback failed."
          ),
      },
      400
    );
  }
}

// ============================================================
// MAIN DISPATCHER
// ============================================================

async function dispatch(
  req: NextRequest
): Promise<Response> {
  const route =
    getRoute(req);

  /*
   * Facebook OAuth callback is intentionally handled before
   * the normal authenticated-route check.
   */
  if (
    route ===
    "facebook/oauth/callback"
  ) {
    if (
      req.method !==
      "GET"
    ) {
      return json(
        {
          error:
            "Method not allowed.",
        },
        405
      );
    }

    return handleFacebookOAuthCallback(
      req
    );
  }

  const authResponse =
    await requireAuth(
      req,
      route
    );

  if (authResponse) {
    return authResponse;
  }

  switch (req.method) {
    case "GET":
      return handleGet(
        req,
        route
      );

    case "POST":
      return handlePost(
        req,
        route
      );

    case "PATCH":
      return handlePatch(
        req,
        route
      );

    case "DELETE":
      return handleDelete(
        req,
        route
      );

    default:
      return json(
        {
          error:
            "Method not allowed.",
        },
        405
      );
  }
}

// ============================================================
// NEXT.JS ROUTE HANDLERS
// ============================================================

export async function GET(
  req: NextRequest
) {
  return dispatch(req);
}

export async function POST(
  req: NextRequest
) {
  return dispatch(req);
}

export async function PATCH(
  req: NextRequest
) {
  return dispatch(req);
}

export async function DELETE(
  req: NextRequest
) {
  return dispatch(req);
}

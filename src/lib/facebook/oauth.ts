import { env } from "@/lib/env";
import { getFacebookCredentials } from "@/lib/facebook/credentials";
import { getSettings, updateSettings } from "@/lib/db/settings";

/** Graph API version this app is pinned to. */
export const GRAPH_VERSION = "v26.0";
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
];

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

export interface FacebookPage {
  id: string;
  name: string;
  category: string | null;
  access_token: string;
}

async function graphGet(
  path: string,
  params: Record<string, string>
): Promise<any> {
  const res = await fetch(
    `${GRAPH_BASE}${path}?${new URLSearchParams(params)}`,
    {
      signal: AbortSignal.timeout(20_000),
    }
  );

  const body = await res.json().catch(() => null);

  if (!res.ok || body?.error) {
    throw new Error(
      body?.error?.message ??
        `Facebook request to ${path} failed (${res.status})`
    );
  }

  return body;
}

export function buildAuthorizeUrl(
  creds: {
    appId: string;
    redirectUri: string;
    configId: string | null;
  },
  state: string
) {
  const params = new URLSearchParams({
    client_id: creds.appId,
    redirect_uri: creds.redirectUri,
    response_type: "code",
    state,
  });

  if (creds.configId) {
    params.set("config_id", creds.configId);
    params.set("override_default_response_type", "true");
  } else {
    params.set("scope", FACEBOOK_SCOPES.join(","));
  }

  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Creates a signed OAuth state value.
 *
 * The state contains a timestamp and HMAC signature so the callback
 * can reject forged or expired OAuth requests.
 */
async function createOAuthState(): Promise<string> {
  const timestamp = Date.now().toString();
  const secret = env.sessionSecret;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp)
  );

  const encoded = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${timestamp}.${encoded}`;
}

async function verifyOAuthState(state: string | null): Promise<boolean> {
  if (!state) return false;

  const separator = state.indexOf(".");
  if (separator <= 0) return false;

  const timestamp = state.slice(0, separator);
  const providedSignature = state.slice(separator + 1);

  const timestampNumber = Number(timestamp);

  if (!Number.isFinite(timestampNumber)) return false;

  // OAuth state valid for 10 minutes.
  if (Math.abs(Date.now() - timestampNumber) > 10 * 60 * 1000) {
    return false;
  }

  const secret = env.sessionSecret;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp)
  );

  const expectedSignature = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return providedSignature === expectedSignature;
}

/**
 * Generates the Facebook OAuth URL.
 */
export async function getFacebookOAuthUrl(): Promise<string> {
  const creds = await getFacebookCredentials(env.siteUrl);

  if (!creds) {
    throw new Error(
      "Facebook is not configured. Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET."
    );
  }

  const state = await createOAuthState();

  return buildAuthorizeUrl(creds, state);
}

/** Short-lived user token. */
export async function exchangeCodeForToken(
  creds: {
    appId: string;
    appSecret: string;
    redirectUri: string;
    configId: string | null;
  },
  code: string
): Promise<TokenResponse> {
  return graphGet("/oauth/access_token", {
    client_id: creds.appId,
    client_secret: creds.appSecret,
    redirect_uri: creds.redirectUri,
    code,
  });
}

/**
 * Exchanges a short-lived user token for a long-lived user token.
 */
export async function exchangeForLongLivedToken(
  creds: {
    appId: string;
    appSecret: string;
    redirectUri: string;
    configId: string | null;
  },
  shortLivedToken: string
): Promise<TokenResponse> {
  return graphGet("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: creds.appId,
    client_secret: creds.appSecret,
    fb_exchange_token: shortLivedToken,
  });
}

/**
 * Fetch Pages connected to the current Facebook user.
 */
export async function getFacebookPages(): Promise<FacebookPage[]> {
  const settings = await getSettings();

  if (!settings.facebook_user_token) {
    throw new Error(
      "Facebook is not connected. Connect Facebook first."
    );
  }

  return fetchPagesWithToken(settings.facebook_user_token);
}

async function fetchPagesWithToken(
  userToken: string
): Promise<FacebookPage[]> {
  const pages: FacebookPage[] = [];

  let after: string | undefined;

  do {
    const params: Record<string, string> = {
      access_token: userToken,
      fields: "id,name,category,access_token,tasks",
      limit: "100",
    };

    if (after) {
      params.after = after;
    }

    const data = await graphGet("/me/accounts", params);

    for (const page of data.data ?? []) {
      if (
        Array.isArray(page.tasks) &&
        !page.tasks.includes("CREATE_CONTENT")
      ) {
        continue;
      }

      pages.push({
        id: page.id,
        name: page.name,
        category: page.category ?? null,
        access_token: page.access_token,
      });
    }

    after =
      data.paging?.cursors?.after && data.paging?.next
        ? data.paging.cursors.after
        : undefined;
  } while (after);

  return pages;
}

/**
 * Return the Page access token for a specific Page.
 */
export async function getFacebookPageToken(
  pageId: string
): Promise<string | null> {
  const pages = await getFacebookPages();

  const page = pages.find((item) => item.id === pageId);

  return page?.access_token ?? null;
}

/**
 * Handles the OAuth callback:
 *
 * code
 *   -> short-lived user token
 *   -> long-lived user token
 *   -> Facebook account
 *   -> Pages
 *   -> save connection in Supabase
 */
export async function handleFacebookOAuthCallback(input: {
  code: string;
  state: string | null;
  requestUrl: string;
}) {
  const validState = await verifyOAuthState(input.state);

  if (!validState) {
    throw new Error(
      "Invalid or expired Facebook OAuth state. Start the Facebook connection again."
    );
  }

  const requestOrigin = new URL(input.requestUrl).origin;

  const creds = await getFacebookCredentials(requestOrigin);

  if (!creds) {
    throw new Error(
      "Facebook is not configured. Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET."
    );
  }

  const shortToken = await exchangeCodeForToken(
    creds,
    input.code
  );

  const longToken = await exchangeForLongLivedToken(
    creds,
    shortToken.access_token
  );

  const account = await graphGet("/me", {
    access_token: longToken.access_token,
    fields: "name",
  });

  const pages = await fetchPagesWithToken(
    longToken.access_token
  );

  const firstPage = pages[0];

  const tokenExpiresAt = longToken.expires_in
    ? new Date(
        Date.now() + longToken.expires_in * 1000
      ).toISOString()
    : null;

  const settingsPatch: Record<string, unknown> = {
    facebook_user_token: longToken.access_token,
    facebook_token_expires_at: tokenExpiresAt,
    facebook_user_name: account.name ?? null,
  };

  if (firstPage) {
    settingsPatch.default_page_id = firstPage.id;
    settingsPatch.default_page_name = firstPage.name;
    settingsPatch.default_page_token = firstPage.access_token;
  } else {
    settingsPatch.default_page_id = null;
    settingsPatch.default_page_name = null;
    settingsPatch.default_page_token = null;
  }

  await updateSettings(settingsPatch);

  return {
    connected: true,
    user: {
      name: account.name ?? null,
    },
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      category: page.category,
    })),
    defaultPage: firstPage
      ? {
          id: firstPage.id,
          name: firstPage.name,
        }
      : null,
  };
}

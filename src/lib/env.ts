/**
 * Centralised, typed access to environment variables.
 *
 * AI provider configuration:
 *
 * Text:
 *   1. Groq
 *   2. Gemini
 *   3. Local template
 *
 * Image:
 *   1. Gemini 3.1 Flash Image
 *   2. Pexels
 *
 * Pollinations is NOT used anywhere.
 */

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Check .env.local or Vercel Environment Variables.`
    );
  }

  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  // =========================================================
  // SUPABASE
  // =========================================================

  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },

  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },

  // =========================================================
  // ADMIN AUTH
  // =========================================================

  get adminPassword() {
    return required("ADMIN_PASSWORD");
  },

  get sessionSecret() {
    return required("SESSION_SECRET");
  },

  // =========================================================
  // FACEBOOK / META
  // =========================================================

  get facebookAppIdOptional() {
    return optional("FACEBOOK_APP_ID");
  },

  get facebookAppSecretOptional() {
    return optional("FACEBOOK_APP_SECRET");
  },

  get facebookConfigIdOptional() {
    return optional("FACEBOOK_CONFIG_ID");
  },

  /**
   * Optional override for Facebook OAuth redirect URI.
   */
  get facebookRedirectUriOverride() {
    return optional("FACEBOOK_REDIRECT_URI");
  },

  // =========================================================
  // AI PROVIDERS
  // =========================================================

  /**
   * Primary text-generation provider.
   */
  get groqApiKey() {
    return optional("GROQ_API_KEY");
  },

  /**
   * Text fallback + Gemini image generation.
   */
  get geminiApiKey() {
    return optional("GEMINI_API_KEY");
  },

  /**
   * Stock image provider / fallback.
   */
  get pexelsApiKey() {
    return optional("PEXELS_API_KEY");
  },

  // =========================================================
  // CRON
  // =========================================================

  get cronSecret() {
    return optional("CRON_SECRET");
  },

  // =========================================================
  // SITE URL
  // =========================================================

  /**
   * Origin this deployment is reachable at.
   *
   * Priority:
   * 1. NEXT_PUBLIC_SITE_URL
   * 2. VERCEL_PROJECT_PRODUCTION_URL
   * 3. VERCEL_URL
   * 4. localhost
   */
  get siteUrl() {
    const explicit = optional("NEXT_PUBLIC_SITE_URL");

    if (explicit) {
      return explicit;
    }

    const vercelHost =
      optional("VERCEL_PROJECT_PRODUCTION_URL") ||
      optional("VERCEL_URL");

    if (vercelHost) {
      return `https://${vercelHost}`;
    }

    return "http://localhost:3000";
  },
};


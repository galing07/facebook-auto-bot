import { supabaseAdmin } from "@/lib/supabase/server";
import type { Topic } from "@/lib/types";

/**
 * Thrown when the database predates the topics feature. Installs made before
 * it shipped have no `topics` table until schema.sql is run again, and that
 * has to surface as an instruction, not a crash — the rest of the app,
 * autopilot included, keeps working without it.
 */
export class TopicsTableMissingError extends Error {
  constructor() {
    super(
      "Your database has no topics table yet. Run supabase/schema.sql again in the Supabase SQL editor — it is safe to re-run and only adds what is missing."
    );
  }
}

// PostgREST reports an unknown table as PGRST205; Postgres itself as 42P01.
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

function raise(error: { code?: string; message: string } | null, action: string): void {
  if (!error) return;
  if (error.code && MISSING_TABLE.has(error.code)) throw new TopicsTableMissingError();
  throw new Error(`Failed to ${action}: ${error.message}`);
}

export const MAX_TOPIC_LENGTH = 200;

/** Trims, collapses inner whitespace and drops a leading bullet or number. */
export function normaliseTopic(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TOPIC_LENGTH);
}

export async function listTopics(): Promise<Topic[]> {
  const { data, error } = await supabaseAdmin()
    .from("topics")
    .select("*")
    .order("created_at", { ascending: true });
  raise(error, "list topics");
  return (data ?? []) as Topic[];
}

/**
 * Adds topics, skipping blanks and anything already present. Matching is
 * case-insensitive, both within the pasted batch and against the stored list,
 * so pasting the same list twice changes nothing.
 */
export async function addTopics(rawTexts: string[]): Promise<{ added: number; skipped: number }> {
  const existing = new Set((await listTopics()).map((t) => t.text.toLowerCase()));

  const fresh: string[] = [];
  let skipped = 0;
  for (const raw of rawTexts) {
    const text = normaliseTopic(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    existing.add(key);
    fresh.push(text);
  }

  if (fresh.length > 0) {
    const { error } = await supabaseAdmin()
      .from("topics")
      .insert(fresh.map((text) => ({ text })));
    raise(error, "add topics");
  }

  return { added: fresh.length, skipped };
}

export async function updateTopic(
  id: string,
  patch: Partial<Pick<Topic, "enabled" | "text">>
): Promise<Topic> {
  const { data, error } = await supabaseAdmin()
    .from("topics")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  raise(error, "update topic");
  return data as Topic;
}

export async function deleteTopic(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("topics").delete().eq("id", id);
  raise(error, "delete topic");
}

/**
 * The enabled topic autopilot would take next: never-used ones first in the
 * order they were added, then whichever was used longest ago. That covers the
 * whole list before anything repeats, and "next up" stays predictable enough
 * to show on screen.
 */
export async function nextTopic(): Promise<Topic | null> {
  const { data, error } = await supabaseAdmin()
    .from("topics")
    .select("*")
    .eq("enabled", true)
    .order("last_used_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(1);
  raise(error, "choose a topic");
  return ((data ?? [])[0] as Topic | undefined) ?? null;
}

export async function markTopicUsed(topic: Topic): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("topics")
    .update({ use_count: topic.use_count + 1, last_used_at: new Date().toISOString() })
    .eq("id", topic.id);
  raise(error, "record topic use");
}

// Compatibility aliases for API route
export const getTopics = listTopics;
export const createTopic = addTopics;


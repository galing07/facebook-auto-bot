import { supabaseAdmin } from "@/lib/supabase/server";

export type TrendTopicRow = {
  id?: string;
  keyword: string;
  geo: string;
  trend_source: string;
  trend_score: number;
  freshness_score: number;
  niche_score: number;
  safety_score: number;
  content_score: number;
  total_score: number;
  status: "new" | "queued" | "used" | "rejected";
  first_seen_at?: string;
  last_seen_at?: string;
  used_at?: string | null;
  metadata?: Record<string, unknown>;
};

const STOP = new Set([
  "breaking","live","today","news","update","video","watch","latest",
  "what","when","where","how","why"
]);

function scoreKeyword(keyword: string, index: number, total: number) {
  const text = keyword.trim();
  const words = text.toLowerCase().split(/\\s+/).filter(Boolean);
  const usefulWords = words.filter(w => !STOP.has(w));
  const trendScore = Math.max(35, 100 - index * Math.min(4, 60 / Math.max(total, 1)));
  const freshnessScore = 100;
  const contentScore = Math.min(100, 45 + usefulWords.length * 12 + (text.includes(" ") ? 10 : 0));
  const safetyScore = /casino|porn|sex|nude|weapon|gun|terror|suicide|drug/i.test(text) ? 10 : 100;
  const nicheScore = usefulWords.length >= 2 ? 85 : 55;
  const totalScore = trendScore * .30 + freshnessScore * .15 + nicheScore * .20 + safetyScore * .20 + contentScore * .15;
  return { trendScore, freshnessScore, nicheScore, safetyScore, contentScore, totalScore };
}

export async function collectTrendTopics(geo = "US") {
  const res = await fetch(
    `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${encodeURIComponent(geo)}`,
    { signal: AbortSignal.timeout(8000), next: { revalidate: 600 } }
  );
  if (!res.ok) throw new Error(`Google Trends RSS ${res.status}`);
  const xml = await res.text();

  const keywords = [...xml.matchAll(/<title>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/title>/g)]
    .map(m => m[1].trim())
    .filter(Boolean)
    .filter(t => !/daily search trends/i.test(t));

  const unique = [...new Set(keywords)].slice(0, 50);
  const rows = unique.map((keyword, index) => {
    const s = scoreKeyword(keyword, index, unique.length);
    return {
      keyword,
      geo,
      trend_source: "google_trends",
      trend_score: s.trendScore,
      freshness_score: s.freshnessScore,
      niche_score: s.nicheScore,
      safety_score: s.safetyScore,
      content_score: s.contentScore,
      total_score: Number(s.totalScore.toFixed(2)),
      status: s.safetyScore < 50 ? "rejected" : "queued",
      last_seen_at: new Date().toISOString(),
      metadata: { rank: index + 1 }
    };
  });

  const { error } = await supabaseAdmin()
    .from("trend_topics")
    .upsert(rows, { onConflict: "keyword,geo" });

  if (error) throw new Error(`Failed to save trend topics: ${error.message}`);
  return { geo, collected: rows.length, topics: rows };
}

export async function getBestTrendTopics(geo = "US", limit = 10) {
  const { data, error } = await supabaseAdmin()
    .from("trend_topics")
    .select("*")
    .eq("geo", geo)
    .eq("status", "queued")
    .order("total_score", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to read trend queue: ${error.message}`);
  return (data ?? []) as TrendTopicRow[];
}

export async function markTrendUsed(id: string) {
  const { error } = await supabaseAdmin()
    .from("trend_topics")
    .update({ status: "used", used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Failed to mark trend used: ${error.message}`);
}

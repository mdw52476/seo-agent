/**
 * Stage 2: Keyword Researcher
 *
 * 1. Claude generates seed keywords from the SiteAnalysis
 * 2. Google Autocomplete expands each seed into long-tail variants
 * 3. Claude scores each keyword (volume proxy, difficulty, intent, article type)
 * 4. Returns ranked keyword list ready for the Content Planner
 */


import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import { analyzeSite } from './site-analyzer.js';
import type { SiteAnalysis, Keyword, ArticleType } from '../lib/types.js';

const client = new Anthropic();

// ── Google Autocomplete ─────────────────────────────────────────────────────

const AUTOCOMPLETE_PREFIXES = ['', 'how to ', 'best ', 'what is ', 'vs ', 'near me '];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

async function fetchAutocomplete(query: string): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as [string, string[]];
    return data[1] ?? [];
  } catch {
    return [];
  }
}

async function expandSeeds(seeds: string[]): Promise<string[]> {
  const all = new Set<string>();

  // For each seed: try bare seed + alphabet suffix expansions + prefix variants
  const tasks: Promise<string[]>[] = [];

  for (const seed of seeds) {
    // bare seed
    tasks.push(fetchAutocomplete(seed));

    // prefix variants (how to, best, vs, etc.)
    for (const prefix of AUTOCOMPLETE_PREFIXES.slice(1)) {
      tasks.push(fetchAutocomplete(`${prefix}${seed}`));
    }

    // alphabet expansion: "seed a", "seed b", ...
    for (const letter of ALPHABET) {
      tasks.push(fetchAutocomplete(`${seed} ${letter}`));
    }
  }

  // Batch with concurrency limit of 8
  const CONCURRENCY = 8;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch);
    results.flat().forEach((kw) => kw && all.add(kw.toLowerCase().trim()));
    // polite delay between batches
    if (i + CONCURRENCY < tasks.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return [...all];
}

// ── Claude: generate seeds ──────────────────────────────────────────────────

async function generateSeeds(site: SiteAnalysis): Promise<string[]> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `You are an SEO expert. Generate 8-10 short seed keywords (2-4 words each) for a website with this profile:

Niche: ${site.niche}
Target audience: ${site.targetAudience}
Products/services: ${site.products.join(', ')}
Competitors: ${site.topCompetitorUrls.join(', ')}

Focus on INFORMATIONAL and TRANSACTIONAL intents: cost questions, how-to topics, comparisons, safety/care tips, process explanations, and service decision guides.
DO NOT generate "best [service] in [city]" seeds — those produce low-value directory articles. Generate seeds that lead to helpful, unique content.

Return ONLY a JSON array of strings. No markdown, no explanation.
Example: ["best project management tools","how to manage remote teams","async vs sync communication","project tracking software cost"]`,
      },
    ],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '[]';
  const cleaned = text.replace(/```json\n?|```/g, '').trim();
  return JSON.parse(cleaned) as string[];
}

// ── Drop city-directory keywords entirely ──────────────────────────────────
// "best [service] in [city]" style keywords only produce low-value
// directory articles. Remove them so the planner never sees them.

const CITY_DIR_RE = /\b(best|top|cheapest|nearest)\b.{2,35}\b(in|near)\b\s+\w[\w\s]{2,25}\b(,\s*)?(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i;

function dropCityDirectories(keywords: string[]): string[] {
  return keywords.filter((kw) => !CITY_DIR_RE.test(kw));
}

// ── Pre-filter: keep only niche-relevant keywords ──────────────────────────

function preFilter(keywords: string[], site: SiteAnalysis, maxKeep = 200): string[] {
  // Build a relevance term set from niche + products
  const nicheWords = [
    ...site.niche.toLowerCase().split(/\s+/),
    ...site.products.flatMap((p) => p.toLowerCase().split(/\s+/)),
  ].filter((w) => w.length > 3);

  const scored = keywords.map((kw) => {
    const hits = nicheWords.filter((w) => kw.includes(w)).length;
    return { kw, hits };
  });

  return scored
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, maxKeep)
    .map((s) => s.kw);
}

// ── Extract JSON array from Claude response (robust) ───────────────────────

function extractJsonArray(text: string): unknown[] {
  // Strip markdown fences
  const cleaned = text.replace(/```json\n?|```/g, '').trim();
  // Try direct parse first
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  // Find the outermost [ ... ] block
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return [];
}

// ── Claude: score & classify keywords ──────────────────────────────────────

const ARTICLE_TYPES: ArticleType[] = ['listicle', 'how-to', 'vs', 'news', 'qa', 'roundup', 'review'];

async function scoreKeywords(
  keywords: string[],
  site: SiteAnalysis
): Promise<Keyword[]> {
  const CHUNK = 25;
  const scored: Keyword[] = [];

  for (let i = 0; i < keywords.length; i += CHUNK) {
    const chunk = keywords.slice(i, i + CHUNK);
    const chunkNum = Math.floor(i / CHUNK) + 1;
    const totalChunks = Math.ceil(keywords.length / CHUNK);
    logger.info('KeywordResearcher', `Scoring chunk ${chunkNum}/${totalChunks}…`);

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `You are an SEO analyst. Score these keywords for a website in the "${site.niche}" niche targeting "${site.targetAudience}".

Keywords to score:
${chunk.map((k, n) => `${n + 1}. ${k}`).join('\n')}

Return a JSON array where each element has exactly these fields:
{"keyword":"...","searchVolume":0,"difficulty":0,"score":0,"articleType":"how-to"}

Field rules:
- searchVolume: estimated monthly US searches (integer)
- difficulty: 0-100, lower = easier to rank
- score: 0-100 opportunity score (local + long-tail = higher; brand-dominated = lower)
- articleType: one of ${ARTICLE_TYPES.join('|')}
  - "vs" in keyword → "vs"
  - question keywords (how,what,why,when,is,can,does) → "qa"
  - "best","top","cheapest" → "listicle"
  - "how to","guide","steps" → "how-to"
  - "review","rating","worth" → "review"
  - otherwise → "roundup"

Return ONLY the raw JSON array, no markdown fences, no explanation.`,
        },
      ],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '[]';
    const arr = extractJsonArray(text);
    if (arr.length > 0) {
      scored.push(...(arr as Keyword[]));
    } else {
      logger.warn('KeywordResearcher', `Chunk ${chunkNum} returned unparseable response`);
    }

    if (i + CHUNK < keywords.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return scored;
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function researchKeywords(
  site: SiteAnalysis,
  opts: { topN?: number } = {}
): Promise<Keyword[]> {
  const { topN = 50 } = opts;

  logger.info('KeywordResearcher', 'Generating seed keywords with Claude…');
  const seeds = await generateSeeds(site);
  logger.success('KeywordResearcher', `Seeds: ${seeds.join(' | ')}`);

  logger.info('KeywordResearcher', `Expanding ${seeds.length} seeds via Google Autocomplete…`);
  const expanded = await expandSeeds(seeds);
  logger.success('KeywordResearcher', `Collected ${expanded.length} raw keywords`);

  // Deduplicate and drop junk
  const deduped = [...new Set(expanded)].filter(
    (k) => k.length > 3 && !/^\d+$/.test(k)
  );

  // Pre-filter to niche-relevant keywords before sending to Claude
  const filtered = preFilter(deduped, site, 200);
  logger.success('KeywordResearcher', `Pre-filtered to ${filtered.length} niche-relevant keywords`);
  logger.info('KeywordResearcher', `Scoring ${filtered.length} keywords…`);

  const scored = await scoreKeywords(filtered, site);

  const ranked = scored
    .filter((k) => k.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((k) => ({ ...k, status: 'pending' as const, siteUrl: site.url }));

  logger.success(
    'KeywordResearcher',
    `Top keyword: "${ranked[0]?.keyword}" (score: ${ranked[0]?.score})`
  );

  return ranked;
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: tsx src/stages/keyword-researcher.ts <url>');
    process.exit(1);
  }

  (async () => {
    const site = await analyzeSite(url);
    const keywords = await researchKeywords(site, { topN: 50 });
    console.log('\n── Top Keywords ──────────────────────────────────────');
    console.log(JSON.stringify(keywords, null, 2));
  })().catch((err) => {
    logger.error('KeywordResearcher', err.message);
    process.exit(1);
  });
}

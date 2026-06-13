/**
 * Stage 3: Content Planner
 *
 * Takes a ranked keyword list and builds a weekly editorial calendar.
 * Each week gets 3-5 articles with varied types (listicle, how-to, vs, qa, roundup, review).
 * Claude generates a compelling title + outline for each article.
 */


import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import { analyzeSite } from './site-analyzer.js';
import { researchKeywords } from './keyword-researcher.js';
import type { SiteAnalysis, Keyword, ContentPlan, PlannedArticle, ArticleType } from '../lib/types.js';
import type { SerpInsights } from './serp-researcher.js';

const client = new Anthropic();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWeekOf(offsetWeeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + 1 + offsetWeeks * 7); // Monday
  return d.toISOString().slice(0, 10);
}

function enforceVariety(keywords: Keyword[], articlesPerWeek: number): Keyword[][] {
  // Spread article types across weeks so no week is all "roundup"
  const typeOrder: ArticleType[] = ['roundup', 'how-to', 'listicle', 'qa', 'vs', 'review', 'roundup'];
  const weeks: Keyword[][] = [];

  const byType: Record<string, Keyword[]> = {};
  for (const kw of keywords) {
    (byType[kw.articleType] ??= []).push(kw);
  }

  // Build a pool ordered by type variety
  const pool: Keyword[] = [];
  let ti = 0;
  const used = new Set<string>();
  while (pool.length < keywords.length) {
    const type = typeOrder[ti % typeOrder.length];
    const available = (byType[type] ?? []).filter((k) => !used.has(k.keyword));
    if (available.length > 0) {
      pool.push(available[0]);
      used.add(available[0].keyword);
    }
    ti++;
    if (used.size >= keywords.length) break;
  }
  // Append any remaining not picked by type-variety loop
  for (const kw of keywords) {
    if (!used.has(kw.keyword)) pool.push(kw);
  }

  for (let i = 0; i < pool.length; i += articlesPerWeek) {
    weeks.push(pool.slice(i, i + articlesPerWeek));
  }
  return weeks;
}

// ── Reclassify city-directory keywords to more interesting types ─────────────

const CITY_DIRECTORY_RE = /\b(best|top|cheapest|nearest)\b.{3,40}\b(in|near)\b.{2,30}\b(oh|al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|ohio|texas|florida|california|illinois|georgia|michigan|pennsylvania)\b/i;
const REMAP_TYPES: ArticleType[] = ['how-to', 'qa', 'listicle', 'vs'];

function reclassifyCityDirectories(keywords: Keyword[]): Keyword[] {
  let cityDirCount = 0;
  let remapIdx = 0;
  return keywords.map((kw) => {
    if (CITY_DIRECTORY_RE.test(kw.keyword) && (kw.articleType === 'roundup' || kw.articleType === 'listicle')) {
      cityDirCount++;
      if (cityDirCount > 1) {
        // Allow the first city-directory through; reclassify the rest
        const newType = REMAP_TYPES[remapIdx % REMAP_TYPES.length];
        remapIdx++;
        return { ...kw, articleType: newType };
      }
    }
    return kw;
  });
}

// ── Claude: generate title + outline per article ─────────────────────────────

async function planArticles(
  keywords: Keyword[],
  site: SiteAnalysis,
  serpInsights?: SerpInsights
): Promise<PlannedArticle[]> {
  keywords = reclassifyCityDirectories(keywords);
  const competitiveContext = serpInsights
    ? `
## Competitive Landscape (from SERP research)
What's already dominating search results: ${serpInsights.dominantArticleTypes.join(', ')}
Topics already heavily covered: ${serpInsights.coveredTopics.join('; ')}
CONTENT GAPS to exploit: ${serpInsights.contentGaps.join('; ')}
Suggested fresh angles: ${serpInsights.suggestedArticleAngles.join('; ')}
Strategic note: ${serpInsights.competitiveNotes}

IMPORTANT: Avoid creating "Best [X] in [City]" directory-style articles unless the keyword has no other viable angle. Use the content gaps and suggested angles above to create diverse, differentiated content.
`
    : '';

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are a senior content strategist for a website with this profile:
Niche: ${site.niche}
Target audience: ${site.targetAudience}
Site URL: ${site.url}
${competitiveContext}
For each keyword below, create an article plan. Return a JSON array where each element has:
{
  "keyword": "exact keyword string",
  "title": "compelling, click-worthy article title (under 65 chars)",
  "articleType": "same as input",
  "outline": ["Section 1 heading", "Section 2 heading", "Section 3 heading", "Section 4 heading", "Section 5 heading"]
}

Article type guidance:
- roundup → curated directory or guide with a fresh angle relevant to the site's niche (comparisons, cost breakdowns, what to look for, top options)
- how-to → step-by-step process titles
- listicle → numbered list titles ("7 Things to Know Before…", "5 Signs You Need…")
- qa → question as title ("How Much Does Windshield Replacement Cost?", "Is It Safe to Drive with a Cracked Windshield?")
- vs → direct comparison ("Mobile vs In-Shop Windshield Replacement: Which Is Better?")
- review → evaluation titles ("Is [Service] Worth It? An Honest Look")

Diversity rule: across this batch of ${keywords.length} articles, ensure NO MORE THAN 1 uses a "Best [X] in [City]" format. Use how-to, qa, listicle, vs, and explainer formats for the rest.

Outline rules:
- 5 sections per article
- Section headings should be H2-worthy (descriptive, keyword-rich)
- Last section should always be a CTA/conclusion

Keywords to plan:
${keywords.map((k) => `- "${k.keyword}" (type: ${k.articleType})`).join('\n')}

Return ONLY the raw JSON array. No markdown.`,
      },
    ],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '[]';
  const cleaned = text.replace(/```json\n?|```/g, '').trim();

  try {
    return JSON.parse(cleaned) as PlannedArticle[];
  } catch {
    // Try to extract array
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as PlannedArticle[];
    }
    throw new Error('Failed to parse article plans from Claude');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function buildContentPlan(
  site: SiteAnalysis,
  keywords: Keyword[],
  opts: { weeksAhead?: number; articlesPerWeek?: number; serpInsights?: SerpInsights } = {}
): Promise<ContentPlan[]> {
  const { weeksAhead = 4, articlesPerWeek = 3, serpInsights } = opts;

  const totalArticles = weeksAhead * articlesPerWeek;
  const selected = keywords.slice(0, totalArticles);

  logger.info('ContentPlanner', `Planning ${selected.length} articles across ${weeksAhead} weeks…`);

  // Split into weekly batches with type variety enforced
  const weeklyBatches = enforceVariety(selected, articlesPerWeek);

  const plans: ContentPlan[] = [];

  for (let w = 0; w < Math.min(weeklyBatches.length, weeksAhead); w++) {
    const batch = weeklyBatches[w];
    logger.info('ContentPlanner', `Generating plans for week ${w + 1} (${batch.length} articles)…`);

    const articles = await planArticles(batch, site, serpInsights);

    // Merge scores back in and set status
    const enriched: PlannedArticle[] = articles.map((a) => ({
      ...a,
      status: 'planned' as const,
    }));

    plans.push({
      weekOf: getWeekOf(w),
      siteUrl: site.url,
      articles: enriched,
    });

    if (w < weeklyBatches.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  logger.success(
    'ContentPlanner',
    `Built ${plans.length}-week calendar with ${plans.reduce((s, p) => s + p.articles.length, 0)} articles`
  );

  return plans;
}

// ── Pretty-print calendar ─────────────────────────────────────────────────────

export function printCalendar(plans: ContentPlan[]) {
  for (const week of plans) {
    console.log(`\n📅 Week of ${week.weekOf}`);
    console.log('─'.repeat(60));
    for (const article of week.articles) {
      console.log(`  [${article.articleType.padEnd(8)}] ${article.title}`);
      console.log(`              keyword: "${article.keyword}"`);
      for (const section of article.outline) {
        console.log(`              • ${section}`);
      }
      console.log();
    }
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: tsx src/stages/content-planner.ts <url>');
    process.exit(1);
  }

  (async () => {
    const site = await analyzeSite(url);
    const keywords = await researchKeywords(site, { topN: 50 });
    const plans = await buildContentPlan(site, keywords, { weeksAhead: 4, articlesPerWeek: 3 });
    printCalendar(plans);
    console.log('\n── Raw JSON ─────────────────────────────────────────');
    console.log(JSON.stringify(plans, null, 2));
  })().catch((err) => {
    logger.error('ContentPlanner', err.message);
    process.exit(1);
  });
}

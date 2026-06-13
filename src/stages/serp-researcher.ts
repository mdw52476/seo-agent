/**
 * Stage 2b: SERP Researcher
 *
 * For the top N keywords, fetches DuckDuckGo search results, crawls the top
 * ranking pages with Cheerio, and extracts heading structure + topics.
 * Returns a competitive landscape summary that the Content Planner uses to
 * generate diverse, gap-filling article ideas instead of defaulting to
 * "Best X in City" directories.
 */


import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { logger } from '../lib/logger.js';
import type { Keyword, SiteAnalysis } from '../lib/types.js';

const client = new Anthropic();

// ── DuckDuckGo HTML search ───────────────────────────────────────────────────

async function searchDDG(query: string): Promise<string[]> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const urls: string[] = [];
    $('a.result__url, .result__extras__url, a[href*="uddg="]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      // DDG wraps URLs in redirect links — extract the real URL
      const match = href.match(/uddg=([^&]+)/);
      if (match) {
        try {
          const decoded = decodeURIComponent(match[1]);
          if (decoded.startsWith('http') && !decoded.includes('duckduckgo.com')) {
            urls.push(decoded);
          }
        } catch { /* ignore decode errors */ }
      } else if (href.startsWith('http') && !href.includes('duckduckgo.com')) {
        urls.push(href);
      }
    });

    // Also try result titles that are anchor links
    $('a.result__a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const match = href.match(/uddg=([^&]+)/);
      if (match) {
        try {
          const decoded = decodeURIComponent(match[1]);
          if (decoded.startsWith('http') && !decoded.includes('duckduckgo.com')) {
            urls.push(decoded);
          }
        } catch { /* ignore */ }
      }
    });

    // Deduplicate and return top 5
    return [...new Set(urls)].slice(0, 5);
  } catch {
    return [];
  }
}

// ── Crawl a single page for heading structure ────────────────────────────────

interface PageHeadings {
  url: string;
  title: string;
  h1: string[];
  h2: string[];
  h3: string[];
  wordCount: number;
}

async function crawlPage(url: string): Promise<PageHeadings | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Remove noise
    $('script, style, nav, footer, header, aside, .sidebar, #sidebar, .menu, .nav').remove();

    const getText = (selector: string) =>
      $(selector).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const wordCount = bodyText.split(/\s+/).length;

    return {
      url,
      title: $('title').first().text().trim(),
      h1: getText('h1').slice(0, 3),
      h2: getText('h2').slice(0, 10),
      h3: getText('h3').slice(0, 10),
      wordCount,
    };
  } catch {
    return null;
  }
}

// ── Research one keyword: search + crawl top pages ───────────────────────────

interface KeywordSerpData {
  keyword: string;
  topPages: PageHeadings[];
}

async function researchOneKeyword(keyword: string): Promise<KeywordSerpData> {
  const urls = await searchDDG(keyword);
  const pages: PageHeadings[] = [];

  // Crawl top 3 pages concurrently (avoid hammering servers)
  const results = await Promise.allSettled(urls.slice(0, 3).map(crawlPage));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) pages.push(r.value);
  }

  return { keyword, topPages: pages };
}

// ── Claude: synthesise competitive gaps ─────────────────────────────────────

export interface SerpInsights {
  dominantArticleTypes: string[];
  coveredTopics: string[];
  contentGaps: string[];
  suggestedArticleAngles: string[];
  competitiveNotes: string;
}

async function synthesiseInsights(
  serpData: KeywordSerpData[],
  site: SiteAnalysis
): Promise<SerpInsights> {
  // Build a compact summary of what we found
  const summary = serpData
    .map((kd) => {
      if (kd.topPages.length === 0) return `Keyword: "${kd.keyword}" — no crawlable results`;
      const pagesText = kd.topPages
        .map(
          (p, i) =>
            `  Page ${i + 1}: ${p.title}\n` +
            (p.h1.length ? `    H1: ${p.h1.join(' | ')}\n` : '') +
            (p.h2.length ? `    H2s: ${p.h2.slice(0, 6).join(' | ')}\n` : '') +
            `    ~${p.wordCount} words`
        )
        .join('\n');
      return `Keyword: "${kd.keyword}"\n${pagesText}`;
    })
    .join('\n\n');

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a content strategist. A website in the "${site.niche}" niche targeting "${site.targetAudience}" wants to create content that stands out from competitors.

Here is what is currently ranking for top keywords in this niche:

${summary}

Analyse this competitive landscape and return a JSON object with:
{
  "dominantArticleTypes": ["list of article formats dominating the SERPs, e.g. 'local directory listings', 'how-to guides'"],
  "coveredTopics": ["topics already heavily covered that are hard to break into"],
  "contentGaps": ["specific topic gaps and underserved angles NOT covered by current top results"],
  "suggestedArticleAngles": ["8-12 specific article ideas with fresh angles that would differentiate — NOT 'Best X in City' style unless there is a genuine gap. Include how-to guides, FAQ posts, cost breakdowns, comparison posts, explainers, local guides with unique angles, myth-busting posts, process walkthroughs, etc."],
  "competitiveNotes": "one paragraph summarising the opportunity"
}

Return ONLY valid JSON. No markdown fences.`,
      },
    ],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}';
  const cleaned = text.replace(/```json\n?|```/g, '').trim();
  try {
    return JSON.parse(cleaned) as SerpInsights;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as SerpInsights;
    }
    // Fallback — return empty structure so pipeline continues
    return {
      dominantArticleTypes: [],
      coveredTopics: [],
      contentGaps: [],
      suggestedArticleAngles: [],
      competitiveNotes: 'SERP research failed to parse',
    };
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function researchSerps(
  keywords: Keyword[],
  site: SiteAnalysis,
  opts: { sampleSize?: number } = {}
): Promise<SerpInsights> {
  const { sampleSize = 5 } = opts;

  // Sample the top keywords by score — pick a variety of types
  const sample = keywords.slice(0, Math.min(sampleSize, keywords.length));

  logger.info('SerpResearcher', `Researching SERPs for ${sample.length} keywords…`);

  const serpData: KeywordSerpData[] = [];
  for (const kw of sample) {
    logger.info('SerpResearcher', `  Searching: "${kw.keyword}"`);
    const data = await researchOneKeyword(kw.keyword);
    serpData.push(data);
    const found = data.topPages.length;
    logger.info('SerpResearcher', `  → ${found} page${found !== 1 ? 's' : ''} crawled`);
    // Polite delay between searches
    await new Promise((r) => setTimeout(r, 800));
  }

  const pagesFound = serpData.reduce((n, d) => n + d.topPages.length, 0);
  logger.success('SerpResearcher', `Crawled ${pagesFound} competitor pages — synthesising gaps…`);

  const insights = await synthesiseInsights(serpData, site);

  logger.success('SerpResearcher', `Found ${insights.contentGaps.length} content gaps, ${insights.suggestedArticleAngles.length} article angles`);

  return insights;
}

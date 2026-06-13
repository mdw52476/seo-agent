/**
 * Stage 1: Site Analyzer
 *
 * Crawls a target website and uses Claude to extract:
 * - Site description and niche
 * - Target audience
 * - Products / services offered
 * - Top competitor URLs (inferred from external links + Claude reasoning)
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { crawlPage } from '../lib/crawler.js';
import { logger } from '../lib/logger.js';
import { logSiteProfile } from '../lib/supabase.js';
import type { SiteAnalysis } from '../lib/types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROFILE_PATH = join(process.cwd(), 'site-profile.json');
const PROFILE_MAX_AGE_DAYS = 30;

const client = new Anthropic();

const ANALYSIS_PROMPT = (crawlJson: string) => `
You are an expert SEO analyst. Analyze the following website crawl data and return a structured JSON object.

Crawl data:
${crawlJson}

Return ONLY valid JSON (no markdown, no explanation) with this exact shape:
{
  "description": "2-3 sentence description of what the site is and does",
  "niche": "single descriptive niche label, e.g. 'B2B SaaS project management'",
  "targetAudience": "specific audience description, e.g. 'small business owners and freelancers managing client projects'",
  "products": ["list", "of", "main", "products", "or", "services"],
  "topCompetitorUrls": ["https://competitor1.com", "https://competitor2.com"]
}

Rules:
- topCompetitorUrls: pick up to 5 real competitor domains from the external links. If none are obvious, infer likely competitors from the niche and return their root URLs.
- Keep all values concise and factual. No speculation beyond what the data supports.
- products: list up to 6 items.
`;

function loadCachedProfile(): SiteAnalysis | null {
  if (!existsSync(PROFILE_PATH)) return null;
  try {
    const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8')) as SiteAnalysis;
    const ageMs = Date.now() - new Date(profile.analyzedAt).getTime();
    if (ageMs < PROFILE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return profile;
  } catch {}
  return null;
}

export async function analyzeSite(url: string, opts: { forceRefresh?: boolean } = {}): Promise<SiteAnalysis> {
  if (!opts.forceRefresh) {
    const cached = loadCachedProfile();
    if (cached) {
      logger.info('SiteAnalyzer', `Using cached profile for: ${cached.niche} (${cached.analyzedAt.slice(0, 10)})`);
      return cached;
    }
  }

  logger.info('SiteAnalyzer', `Starting fresh analysis for: ${url}`);

  // Step 1: Crawl the homepage
  const crawl = await crawlPage(url);
  logger.success('SiteAnalyzer', `Crawled: ${crawl.title || url}`);

  // Step 2: Also crawl /about and /products if they exist (best-effort)
  const extraPaths = ['/about', '/about-us', '/products', '/services'];
  const extraCrawls = await Promise.allSettled(
    extraPaths.map((p) => crawlPage(new URL(p, crawl.url).href))
  );

  const extraTexts = extraCrawls
    .filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof crawlPage>>>).value)
    .map((c) => `[${c.url}] ${c.title} — ${c.bodyText.slice(0, 1500)}`)
    .join('\n\n');

  // Compact crawl summary for Claude
  const crawlSummary = {
    url: crawl.url,
    title: crawl.title,
    metaDescription: crawl.metaDescription,
    h1s: crawl.h1s.slice(0, 5),
    h2s: crawl.h2s.slice(0, 10),
    bodyTextSnippet: crawl.bodyText.slice(0, 3000),
    externalLinks: crawl.externalLinks.slice(0, 20),
    extraPages: extraTexts,
  };

  logger.info('SiteAnalyzer', 'Sending crawl data to Claude for analysis…');

  // Step 3: Claude analysis
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: ANALYSIS_PROMPT(JSON.stringify(crawlSummary, null, 2)),
      },
    ],
  });

  const rawText =
    message.content[0].type === 'text' ? message.content[0].text : '';

  // Step 4: Parse the JSON Claude returned
  let parsed: Omit<SiteAnalysis, 'url' | 'title' | 'analyzedAt'>;
  try {
    // Claude sometimes wraps in ```json ... ``` even when asked not to — strip it
    const cleaned = rawText.replace(/```json\n?|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    logger.error('SiteAnalyzer', `Failed to parse Claude response:\n${rawText}`);
    throw new Error('Claude returned invalid JSON');
  }

  const result: SiteAnalysis = {
    url: crawl.url,
    title: crawl.title,
    ...parsed,
    analyzedAt: new Date().toISOString(),
  };

  // Cache locally and push to Supabase
  writeFileSync(PROFILE_PATH, JSON.stringify(result, null, 2));
  await logSiteProfile(result);

  logger.success('SiteAnalyzer', `Analysis complete for: ${result.niche}`);
  return result;
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
// Run directly: tsx src/stages/site-analyzer.ts https://example.com

import { fileURLToPath } from 'url';
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: tsx src/stages/site-analyzer.ts <url>');
    process.exit(1);
  }
  analyzeSite(url)
    .then((result) => {
      console.log('\n' + JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      logger.error('SiteAnalyzer', err.message);
      process.exit(1);
    });
}

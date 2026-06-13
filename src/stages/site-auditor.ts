/**
 * Stage 6: Site Auditor
 *
 * Crawls all pages on the target site and scores them against SEO best practices.
 * Outputs a prioritized fix list grouped by severity: critical, warning, recommendation.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { crawlPage } from '../lib/crawler.js';
import { logger } from '../lib/logger.js';
import type { SiteAnalysis } from '../lib/types.js';

const client = new Anthropic();

// ── Types ─────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'recommendation';

export interface AuditIssue {
  severity: Severity;
  page: string;
  rule: string;
  detail: string;
  fix: string;
  autoFixable: boolean; // can the fixer apply this without human input?
}

export interface AuditReport {
  siteUrl: string;
  auditedAt: string;
  pagesChecked: number;
  issues: AuditIssue[];
  score: number; // 0-100
}

// ── SEO Rules ─────────────────────────────────────────────────────────────────

interface PageData {
  url: string;
  title: string;
  metaDescription: string;
  h1s: string[];
  h2s: string[];
  bodyText: string;
  wordCount: number;
  hasSchema: boolean;
  schemaTypes: string[];
  internalLinks: string[];
  externalLinks: string[];
}

function auditPage(page: PageData, keyword?: string): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const p = page.url;

  // Title checks
  if (!page.title) {
    issues.push({ severity: 'critical', page: p, rule: 'Missing title tag', detail: 'Page has no <title>', fix: `Add a descriptive title tag (50-65 chars)`, autoFixable: true });
  } else if (page.title.length < 30) {
    issues.push({ severity: 'warning', page: p, rule: 'Title too short', detail: `Title is ${page.title.length} chars: "${page.title}"`, fix: 'Expand title to 50-65 characters with keyword', autoFixable: true });
  } else if (page.title.length > 65) {
    issues.push({ severity: 'warning', page: p, rule: 'Title too long', detail: `Title is ${page.title.length} chars — will be truncated in SERPs`, fix: 'Shorten title to under 65 characters', autoFixable: true });
  }

  // Meta description checks
  if (!page.metaDescription) {
    issues.push({ severity: 'critical', page: p, rule: 'Missing meta description', detail: 'No meta description found', fix: 'Add a meta description (150-160 chars) summarising the page', autoFixable: true });
  } else if (page.metaDescription.length < 70) {
    issues.push({ severity: 'warning', page: p, rule: 'Meta description too short', detail: `Meta is ${page.metaDescription.length} chars`, fix: 'Expand meta description to 150-160 characters', autoFixable: true });
  } else if (page.metaDescription.length > 160) {
    issues.push({ severity: 'warning', page: p, rule: 'Meta description too long', detail: `Meta is ${page.metaDescription.length} chars — will be truncated`, fix: 'Shorten meta description to under 160 characters', autoFixable: true });
  }

  // H1 checks
  if (page.h1s.length === 0) {
    issues.push({ severity: 'critical', page: p, rule: 'Missing H1', detail: 'No H1 tag found on page', fix: 'Add a single H1 tag that includes the primary keyword', autoFixable: true });
  } else if (page.h1s.length > 1) {
    issues.push({ severity: 'warning', page: p, rule: 'Multiple H1 tags', detail: `Found ${page.h1s.length} H1 tags: ${page.h1s.slice(0,2).join(' | ')}`, fix: 'Keep only one H1 per page', autoFixable: false });
  }

  // H2 checks
  if (page.h2s.length === 0 && page.wordCount > 300) {
    issues.push({ severity: 'warning', page: p, rule: 'No H2 headings', detail: 'Page has content but no H2 structure', fix: 'Add H2 headings to break up content and add keyword variants', autoFixable: false });
  }

  // Thin content
  if (page.wordCount < 300) {
    issues.push({ severity: 'warning', page: p, rule: 'Thin content', detail: `Only ${page.wordCount} words on page`, fix: 'Add more substantive content (aim for 300+ words minimum)', autoFixable: false });
  }

  // Keyword in title
  if (keyword && page.title && !page.title.toLowerCase().includes(keyword.toLowerCase().split(' ')[0])) {
    issues.push({ severity: 'recommendation', page: p, rule: 'Keyword not in title', detail: `Primary keyword "${keyword}" not found in title`, fix: `Include "${keyword}" or a close variant in the title tag`, autoFixable: true });
  }

  // Keyword in H1
  if (keyword && page.h1s.length > 0) {
    const h1Text = page.h1s[0].toLowerCase();
    const keywordWords = keyword.toLowerCase().split(' ').filter(w => w.length > 3);
    const matches = keywordWords.filter(w => h1Text.includes(w)).length;
    if (matches < keywordWords.length / 2) {
      issues.push({ severity: 'recommendation', page: p, rule: 'Keyword weak in H1', detail: `H1 "${page.h1s[0]}" doesn't strongly reflect the keyword`, fix: 'Rewrite H1 to include primary keyword naturally', autoFixable: true });
    }
  }

  // Keyword in meta
  if (keyword && page.metaDescription && !page.metaDescription.toLowerCase().includes(keyword.toLowerCase().split(' ')[0])) {
    issues.push({ severity: 'recommendation', page: p, rule: 'Keyword not in meta description', detail: 'Primary keyword missing from meta description', fix: 'Include keyword naturally in meta description', autoFixable: true });
  }

  // Schema markup checks
  if (!page.hasSchema) {
    const isBlog = p.includes('/blog/');
    const isDirectory = !isBlog && p.split('/').length >= 4;
    if (isBlog) {
      issues.push({ severity: 'warning', page: p, rule: 'Missing schema markup', detail: 'No JSON-LD structured data found on blog post', fix: 'Add Article + BreadcrumbList JSON-LD schema', autoFixable: true });
    } else if (isDirectory) {
      issues.push({ severity: 'warning', page: p, rule: 'Missing schema markup', detail: 'No JSON-LD structured data found on directory page', fix: 'Add FAQPage + BreadcrumbList JSON-LD schema', autoFixable: true });
    }
  } else {
    const missing: string[] = [];
    if (p.includes('/blog/') && !page.schemaTypes.includes('Article') && !page.schemaTypes.includes('BlogPosting')) missing.push('Article');
    if (!page.schemaTypes.includes('BreadcrumbList')) missing.push('BreadcrumbList');
    if (missing.length > 0) {
      issues.push({ severity: 'recommendation', page: p, rule: 'Incomplete schema markup', detail: `Missing schema types: ${missing.join(', ')}`, fix: `Add ${missing.join(' and ')} JSON-LD to existing schema`, autoFixable: true });
    }
  }

  // Internal linking checks
  if (p.includes('/blog/')) {
    const directoryLinks = page.internalLinks.filter(l => {
      const parts = l.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
      return parts.length >= 2 && !l.includes('/blog');
    });
    if (directoryLinks.length === 0) {
      issues.push({ severity: 'recommendation', page: p, rule: 'No internal links to directory pages', detail: 'Blog post has no links to directory pages', fix: 'Add 2-3 contextual links to relevant directory pages within the article body', autoFixable: true });
    }
  }

  return issues;
}

// ── Discover pages to audit ───────────────────────────────────────────────────

async function discoverPages(siteUrl: string): Promise<string[]> {
  logger.info('SiteAuditor', 'Discovering pages via sitemap…');

  const urls = new Set<string>();

  // Try sitemap.xml
  try {
    const res = await fetch(`${siteUrl}/sitemap.xml`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const xml = await res.text();
      const matches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
      for (const m of matches) urls.add(m[1].trim());
      logger.success('SiteAuditor', `Found ${urls.size} URLs in sitemap`);
    }
  } catch {
    logger.warn('SiteAuditor', 'Sitemap not accessible, falling back to crawl');
  }

  // Always include key static pages
  for (const path of ['/', '/blog']) {
    urls.add(`${siteUrl}${path}`);
  }

  return [...urls];
}

// ── Claude: generate AI-powered recommendations ───────────────────────────────

async function getAiRecommendations(
  pages: PageData[],
  site: SiteAnalysis
): Promise<AuditIssue[]> {
  logger.info('SiteAuditor', 'Running AI recommendation pass…');

  const summary = pages.slice(0, 20).map(p => ({
    url: p.url,
    title: p.title,
    h1: p.h1s[0] ?? '',
    h2count: p.h2s.length,
    words: p.wordCount,
    meta: p.metaDescription.slice(0, 80),
  }));

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an SEO expert auditing a website in the "${site.niche}" niche targeting "${site.targetAudience}".

Here are the top pages from the site:
${JSON.stringify(summary, null, 2)}

Identify the top 5-8 strategic SEO recommendations that go BEYOND basic on-page checks — things like:
- Internal linking opportunities between pages
- Topic clusters that are missing
- Title/meta patterns that could be improved site-wide
- Content gaps vs competitors (${site.topCompetitorUrls.slice(0,3).join(', ')})
- Schema markup opportunities (LocalBusiness, FAQ, HowTo)

Return a JSON array of issues:
[{"severity":"recommendation","page":"site-wide","rule":"...","detail":"...","fix":"...","autoFixable":false}]

Return ONLY the JSON array, no markdown.`,
    }],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '[]';
  try {
    const cleaned = text.replace(/```json\n?|```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    return JSON.parse(cleaned.slice(start, end + 1)) as AuditIssue[];
  } catch {
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function auditSite(
  site: SiteAnalysis,
  opts: { maxPages?: number } = {}
): Promise<AuditReport> {
  const { maxPages = 50 } = opts;

  const allUrls = await discoverPages(site.url);
  const urlsToCheck = allUrls.slice(0, maxPages);

  logger.info('SiteAuditor', `Auditing ${urlsToCheck.length} pages…`);

  const pages: PageData[] = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < urlsToCheck.length; i += CONCURRENCY) {
    const batch = urlsToCheck.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(u => crawlPage(u)));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const c = r.value;
        pages.push({
          url: c.url,
          title: c.title,
          metaDescription: c.metaDescription,
          h1s: c.h1s,
          h2s: c.h2s,
          bodyText: c.bodyText,
          wordCount: c.bodyText.split(/\s+/).filter(Boolean).length,
          hasSchema: c.hasSchema,
          schemaTypes: c.schemaTypes,
          internalLinks: c.internalLinks,
          externalLinks: c.externalLinks,
        });
      }
    }
    if (i + CONCURRENCY < urlsToCheck.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  logger.success('SiteAuditor', `Crawled ${pages.length} pages`);

  // Run rule-based checks
  const issues: AuditIssue[] = [];
  for (const page of pages) {
    issues.push(...auditPage(page));
  }

  // Run AI recommendations
  const aiIssues = await getAiRecommendations(pages, site);
  issues.push(...aiIssues);

  // Score: start at 100, deduct per issue
  const deductions: Record<string, number> = { critical: 10, warning: 3, recommendation: 1 };
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + (deductions[i.severity] ?? 1), 0));

  return {
    siteUrl: site.url,
    auditedAt: new Date().toISOString(),
    pagesChecked: pages.length,
    issues,
    score,
  };
}

// ── Pretty print ──────────────────────────────────────────────────────────────

export function printReport(report: AuditReport) {
  const critical = report.issues.filter(i => i.severity === 'critical');
  const warnings = report.issues.filter(i => i.severity === 'warning');
  const recs = report.issues.filter(i => i.severity === 'recommendation');

  console.log(`\n── SEO Audit: ${report.siteUrl} ─────────────────────────────`);
  console.log(`Pages checked: ${report.pagesChecked}  |  Issues: ${report.issues.length}  |  Score: ${report.score}/100`);
  console.log(`Audited: ${report.auditedAt.slice(0, 10)}\n`);

  if (critical.length) {
    console.log(`CRITICAL (${critical.length})`);
    for (const i of critical) {
      console.log(`  ✗ ${i.page.replace(report.siteUrl, '') || '/'}`);
      console.log(`    ${i.rule}: ${i.detail}`);
      console.log(`    → Fix: ${i.fix}\n`);
    }
  }

  if (warnings.length) {
    console.log(`WARNINGS (${warnings.length})`);
    for (const i of warnings) {
      console.log(`  ⚠ ${i.page.replace(report.siteUrl, '') || '/'}`);
      console.log(`    ${i.rule}: ${i.detail}`);
      console.log(`    → Fix: ${i.fix}\n`);
    }
  }

  if (recs.length) {
    console.log(`RECOMMENDATIONS (${recs.length})`);
    for (const i of recs) {
      console.log(`  → ${i.page.replace(report.siteUrl, '') || '/'}`);
      console.log(`    ${i.rule}: ${i.detail}`);
      console.log(`    Fix: ${i.fix}\n`);
    }
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
import { analyzeSite } from './site-analyzer.js';

const isMain = typeof process !== 'undefined' && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  if (!url) { console.error('Usage: tsx src/stages/site-auditor.ts <url>'); process.exit(1); }

  (async () => {
    const site = await analyzeSite(url);
    const report = await auditSite(site);
    printReport(report);
    writeFileSync('audit-report.json', JSON.stringify(report, null, 2));
    console.log(`\nFull report saved to: audit-report.json`);
  })().catch(err => { logger.error('SiteAuditor', err.message); process.exit(1); });
}

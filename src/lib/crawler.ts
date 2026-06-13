import * as cheerio from 'cheerio';
import { logger } from './logger.js';

export interface CrawlResult {
  url: string;
  title: string;
  metaDescription: string;
  h1s: string[];
  h2s: string[];
  bodyText: string;
  internalLinks: string[];
  externalLinks: string[];
  ogData: Record<string, string>;
  hasSchema: boolean;
  schemaTypes: string[];
}

async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SeoAgentBot/1.0; +https://github.com/seo-agent)',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function crawlPage(rawUrl: string): Promise<CrawlResult> {
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  logger.info('Crawler', `Fetching ${url}`);

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const origin = new URL(url).origin;

  const internalLinks: string[] = [];
  const externalLinks: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
    try {
      const resolved = new URL(href, url).href;
      if (resolved.startsWith(origin)) {
        internalLinks.push(resolved);
      } else {
        externalLinks.push(resolved);
      }
    } catch {
      // malformed href — skip
    }
  });

  const ogData: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr('property')?.replace('og:', '') ?? '';
    const content = $(el).attr('content') ?? '';
    if (prop && content) ogData[prop] = content;
  });

  // Extract JSON-LD schema types
  const schemaTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() ?? '');
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        if (entry['@type']) schemaTypes.push(entry['@type']);
        if (entry['@graph']) {
          for (const node of entry['@graph']) {
            if (node['@type']) schemaTypes.push(node['@type']);
          }
        }
      }
    } catch { /* malformed JSON-LD */ }
  });

  // Strip nav/footer/scripts for cleaner body text
  $('nav, footer, script, style, noscript, iframe').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);

  return {
    url,
    title: $('title').first().text().trim(),
    metaDescription:
      $('meta[name="description"]').attr('content')?.trim() ??
      ogData['description'] ??
      '',
    h1s: $('h1')
      .map((_, el) => $(el).text().trim())
      .get(),
    h2s: $('h2')
      .map((_, el) => $(el).text().trim())
      .get(),
    bodyText,
    internalLinks: [...new Set(internalLinks)].slice(0, 50),
    externalLinks: [...new Set(externalLinks)].slice(0, 30),
    ogData,
    hasSchema: schemaTypes.length > 0,
    schemaTypes,
  };
}

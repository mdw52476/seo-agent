/**
 * Tracks published articles locally so the pipeline never repeats a keyword.
 * Stored in published.json at the project root.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const LOG_PATH = join(process.cwd(), 'published.json');

export interface PublishedEntry {
  keyword: string;
  slug: string;
  title: string;
  publishedAt: string;
  url: string;
}

export function loadLog(): PublishedEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LOG_PATH, 'utf-8')) as PublishedEntry[];
  } catch {
    return [];
  }
}

export function isPublished(keyword: string): boolean {
  const log = loadLog();
  const normalized = keyword.toLowerCase().trim();
  return log.some((e) => e.keyword.toLowerCase().trim() === normalized);
}

export function appendLog(entry: PublishedEntry): void {
  const log = loadLog();
  log.push(entry);
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

export function printLog(): void {
  const log = loadLog();
  if (log.length === 0) {
    console.log('No articles published yet.');
    return;
  }
  console.log(`\n── Published Articles (${log.length} total) ─────────────────`);
  console.table(log.map((e) => ({
    date: e.publishedAt.slice(0, 10),
    keyword: e.keyword.slice(0, 45),
    slug: e.slug.slice(0, 40),
  })));
}

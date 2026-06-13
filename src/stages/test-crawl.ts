/**
 * Quick smoke test for the crawler (no API key needed).
 * Run: tsx src/stages/test-crawl.ts https://example.com
 */
import { crawlPage } from '../lib/crawler.js';

const url = process.argv[2] ?? 'https://example.com';
crawlPage(url).then((r) => {
  console.log('title:', r.title);
  console.log('metaDescription:', r.metaDescription);
  console.log('h1s:', r.h1s);
  console.log('h2s:', r.h2s.slice(0, 5));
  console.log('externalLinks:', r.externalLinks.slice(0, 5));
  console.log('bodyText (first 300 chars):', r.bodyText.slice(0, 300));
}).catch(console.error);

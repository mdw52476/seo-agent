/**
 * SEO Agent — main entrypoint
 *
 * Usage:
 *   tsx src/index.ts analyze <url>
 */

import dotenv from 'dotenv';
import { join } from 'path';
dotenv.config({ path: join(process.cwd(), '.env'), override: true });
import { analyzeSite, fingerprintLayout } from './stages/site-analyzer.js';
import { researchKeywords } from './stages/keyword-researcher.js';
import { buildContentPlan, printCalendar } from './stages/content-planner.js';
import { researchSerps } from './stages/serp-researcher.js';
import { writeArticle } from './stages/article-writer.js';
import { publishArticle, migrateDirs } from './stages/publisher.js';
import { logger } from './lib/logger.js';
import { isPublished, appendLog, printLog } from './lib/published-log.js';
import { auditSite, printReport } from './stages/site-auditor.js';
import { fixSite } from './stages/site-fixer.js';
import { logArticle, logAuditReport, logContentPlan } from './lib/supabase.js';

const SITE_ID = process.env.SITE_ID ?? '';

const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'analyze': {
      const url = args[0];
      if (!url) {
        console.error('Usage: tsx src/index.ts analyze <url>');
        process.exit(1);
      }
      const result = await analyzeSite(url);
      console.log('\n── Site Analysis Result ──────────────────────────────');
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'research': {
      const url = args[0];
      if (!url) {
        console.error('Usage: tsx src/index.ts research <url>');
        process.exit(1);
      }
      const site = await analyzeSite(url);
      const keywords = await researchKeywords(site, { topN: 50 });
      console.log('\n── Top Keywords ──────────────────────────────────────');
      console.table(
        keywords.slice(0, 20).map((k) => ({
          keyword: k.keyword,
          score: k.score,
          difficulty: k.difficulty,
          volume: k.searchVolume,
          type: k.articleType,
        }))
      );
      console.log(`\nFull list (${keywords.length} keywords):`);
      console.log(JSON.stringify(keywords, null, 2));
      break;
    }
    case 'plan': {
      const url = args[0];
      if (!url) { console.error('Usage: tsx src/index.ts plan <url>'); process.exit(1); }
      const site = await analyzeSite(url);
      const keywords = await researchKeywords(site, { topN: 50 });
      const serpInsights = await researchSerps(keywords, site, { sampleSize: 5 });
      const plans = await buildContentPlan(site, keywords, { weeksAhead: 4, articlesPerWeek: 3, serpInsights });
      printCalendar(plans);
      console.log('\n── Raw JSON ─────────────────────────────────────────');
      console.log(JSON.stringify(plans, null, 2));
      break;
    }
    case 'write': {
      const url = args[0];
      const idx = parseInt(args[1] ?? '0', 10);
      if (!url) { console.error('Usage: tsx src/index.ts write <url> [article-index]'); process.exit(1); }
      const site = await analyzeSite(url);
      const keywords = await researchKeywords(site, { topN: 50 });
      const plans = await buildContentPlan(site, keywords, { weeksAhead: 1, articlesPerWeek: 3 });
      const allArticles = plans.flatMap((p) => p.articles);
      const target = allArticles[idx];
      if (!target) { logger.error('Main', `No article at index ${idx}`); process.exit(1); }
      const article = await writeArticle(target, site);
      const { writeFileSync } = await import('fs');
      const outFile = `article-${article.slug}.html`;
      writeFileSync(outFile, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${article.title}</title>
<meta name="description" content="${article.metaDescription}">
</head><body><h1>${article.title}</h1>${article.content}</body></html>`);
      console.log(`\nTitle:      ${article.title}`);
      console.log(`Keyword:    ${article.keyword}`);
      console.log(`Words:      ${article.wordCount}`);
      console.log(`Meta:       ${article.metaDescription}`);
      console.log(`Saved to:   ${outFile}`);
      break;
    }
    case 'publish': {
      const url = args[0];
      if (!url) { console.error('Usage: tsx src/index.ts publish <url> [--count N]'); process.exit(1); }

      const countFlag = args.indexOf('--count');
      const count = countFlag !== -1 ? parseInt(args[countFlag + 1] ?? '1', 10) : 1;

      const site = await analyzeSite(url);
      // Fetch more keywords than needed so we have room to skip already-published ones
      const keywords = await researchKeywords(site, { topN: Math.max(50, count * 10) });

      // Filter out already-published keywords
      const fresh = keywords.filter((k) => !isPublished(k.keyword));
      logger.info('Main', `${fresh.length} unpublished keywords available (${keywords.length - fresh.length} already done)`);

      if (fresh.length === 0) {
        logger.warn('Main', 'All researched keywords already published — try expanding keyword research');
        process.exit(0);
      }

      const serpInsights = await researchSerps(fresh, site, { sampleSize: Math.min(5, fresh.length) });
      const plans = await buildContentPlan(site, fresh.slice(0, count * 3), { weeksAhead: 1, articlesPerWeek: count, serpInsights });
      const targets = plans.flatMap((p) => p.articles).slice(0, count);

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        logger.info('Main', `Writing article ${i + 1}/${targets.length}: "${target.title}"`);
        const article = await writeArticle(target, site);
        const result = await publishArticle(article, { siteUrl: site.url });
        const articleUrl = `${site.url}/blog/${article.slug}`;
        appendLog({ keyword: target.keyword, slug: article.slug, title: article.title, publishedAt: new Date().toISOString(), url: articleUrl });
        await logArticle({ siteId: SITE_ID, keyword: target.keyword, slug: article.slug, title: article.title, url: articleUrl, articleType: 'article' });
        console.log(`\nPublished (${i + 1}/${targets.length}): ${articleUrl}`);
      }

      console.log(`\n✓ Done — ${targets.length} article${targets.length > 1 ? 's' : ''} published.`);
      break;
    }
    case 'publish-dir': {
      const url = args[0];
      if (!url) { console.error('Usage: tsx src/index.ts publish-dir <url> [--count N]'); process.exit(1); }

      const countFlag = args.indexOf('--count');
      const count = countFlag !== -1 ? parseInt(args[countFlag + 1] ?? '1', 10) : 1;

      const DIR_CONTENT_PATH = process.env.GITHUB_DIRECTORY_PATH ?? 'content/directories';

      const site = await analyzeSite(url);
      const keywords = await researchKeywords(site, { topN: 100 });

      // Use all keywords not already published as directories
      const dirKeywords = keywords.filter((k) => !isPublished(k.keyword + ':dir'));
      logger.info('Main', `${dirKeywords.length} unpublished directory keywords available`);

      if (dirKeywords.length === 0) {
        logger.warn('Main', 'No city-directory keywords found — try running keyword research first');
        process.exit(0);
      }

      // Plan directories — force roundup type, no SERP reclassification
      const dirKwsForced = dirKeywords.slice(0, count * 3).map((k) => ({ ...k, articleType: 'roundup' as const }));
      const plans = await buildContentPlan(site, dirKwsForced, { weeksAhead: 1, articlesPerWeek: count });
      const targets = plans.flatMap((p) => p.articles).slice(0, count);

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        logger.info('Main', `Writing directory ${i + 1}/${targets.length}: "${target.title}"`);
        const article = await writeArticle(target, site);
        const result = await publishArticle(article, { contentPath: DIR_CONTENT_PATH, siteUrl: site.url });
        appendLog({ keyword: target.keyword, slug: article.slug, title: article.title, publishedAt: new Date().toISOString(), url: result.url });
        appendLog({ keyword: target.keyword + ':dir', slug: article.slug, title: article.title, publishedAt: new Date().toISOString(), url: result.url });
        await logArticle({ siteId: SITE_ID, keyword: target.keyword, slug: article.slug, title: article.title, url: result.url, articleType: 'directory' });
        const liveUrl = `${site.url}/directories/${article.slug}`;
        console.log(`\nPublished directory (${i + 1}/${targets.length}): ${liveUrl}`);
      }

      console.log(`\n✓ Done — ${targets.length} director${targets.length > 1 ? 'ies' : 'y'} published.`);
      break;
    }
    case 'day-guide': {
      const url = args[0];
      if (!url) { console.error('Usage: tsx src/index.ts day-guide <url> [--cycle N]'); process.exit(1); }

      const cycleFlag = args.indexOf('--cycle');
      const cycle = cycleFlag !== -1 ? parseInt(args[cycleFlag + 1] ?? '1', 10) : 1;

      const site = await analyzeSite(url);
      const keywords = await researchKeywords(site, { topN: 60 });
      const fresh = keywords.filter((k) => !isPublished(k.keyword));

      const selected = fresh.slice(0, 30);
      if (selected.length < 10) {
        logger.warn('Main', 'Not enough fresh keywords — clearing published log may help');
      }

      logger.info('Main', `Building 30-day guide from ${selected.length} keywords…`);
      const serpInsights = await researchSerps(selected, site, { sampleSize: 5 });
      const plans = await buildContentPlan(site, selected, { weeksAhead: 10, articlesPerWeek: 3, serpInsights });
      const allArticles = plans.flatMap((p) => p.articles).slice(0, 30);

      // Assign days: every 3rd day is a directory, rest are articles
      const days = allArticles.map((article, i) => ({
        day:         i + 1,
        type:        (i + 1) % 3 === 0 ? 'directory' : 'article',
        keyword:     article.keyword,
        title:       article.title,
        articleType: article.articleType,
        outline:     article.outline,
        status:      'planned',
      }));

      await logContentPlan({ siteId: SITE_ID, cycle, days });
      logger.success('Main', `30-day content plan saved (cycle ${cycle})`);
      break;
    }
    case 'fingerprint': {
      const url = args[0];
      if (!url) { console.error('Usage: tsx src/index.ts fingerprint <url>'); process.exit(1); }
      await fingerprintLayout(url);
      console.log('\n✓ site-layout.md updated.');
      break;
    }
    case 'migrate-dirs': {
      const result = await migrateDirs();
      if (result.moved.length)   console.log(`\nMoved (${result.moved.length}):   ${result.moved.join(', ')}`);
      if (result.skipped.length) console.log(`Skipped (${result.skipped.length}): ${result.skipped.join(', ')}`);
      if (result.errors.length)  console.log(`Errors (${result.errors.length}):  ${result.errors.join(', ')}`);
      break;
    }
    case 'log': {
      printLog();
      break;
    }
    case 'audit': {
      const url = args[0];
      if (!url) { console.error('Usage: tsx src/index.ts audit <url>'); process.exit(1); }
      const site = await analyzeSite(url);
      const report = await auditSite(site);
      printReport(report);
      const { writeFileSync } = await import('fs');
      writeFileSync('audit-report.json', JSON.stringify(report, null, 2));
      await logAuditReport({ siteId: SITE_ID, score: report.score, pagesChecked: report.pagesChecked, issues: report.issues });
      console.log(`\nReport saved to: audit-report.json`);
      break;
    }
    case 'fix': {
      const url = args[0];
      if (!url) { console.error('Usage: tsx src/index.ts fix <url>'); process.exit(1); }
      const { readFileSync, existsSync } = await import('fs');
      let report;
      if (existsSync('audit-report.json')) {
        logger.info('Main', 'Using cached audit-report.json — run "audit" first to refresh');
        report = JSON.parse(readFileSync('audit-report.json', 'utf-8'));
      } else {
        const site = await analyzeSite(url);
        report = await auditSite(site);
        printReport(report);
      }
      const yes = args.includes('--yes') || args.includes('-y');
      // Support targeted single-issue fix: --rule "rule name" --page "url"
      const ruleIdx  = args.indexOf('--rule');
      const pageIdx  = args.indexOf('--page');
      const ruleFilter = ruleIdx  !== -1 ? args[ruleIdx  + 1] : undefined;
      const pageFilter = pageIdx  !== -1 ? args[pageIdx  + 1] : undefined;
      await fixSite(report, { yes, ruleFilter, pageFilter });
      break;
    }
    default:
      console.log(`
SEO Agent
─────────
Commands:
  analyze <url>          Stage 1: analyze a website
  research <url>         Stage 2: keyword research
  plan <url>             Stage 3: generate content calendar
  write <url> [index]    Stage 4: write article (default: index 0)
  publish <url> [--count N]  Write + publish N articles (default: 1)
  audit <url>                Crawl site and generate SEO fix report
  fix <url>                  Show proposed fixes, then apply on confirmation
  log                        Show all published articles
`);
  }
}

main().catch((err) => {
  logger.error('Main', err.message);
  process.exit(1);
});

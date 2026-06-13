/**
 * Stage 7: Site Fixer
 *
 * Reads an audit report, generates specific fixes with Claude,
 * shows a summary of proposed changes, then prompts before committing.
 *
 * Handles two fix targets:
 *   - GitHub files (blog posts, page templates)
 *   - Supabase rows (shop/city page metadata)
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as readline from 'readline';
import { logger } from '../lib/logger.js';
import type { AuditReport, AuditIssue } from './site-auditor.js';

const client = new Anthropic();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_REPO = process.env.GITHUB_REPO ?? '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? 'main';

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function ghGet(path: string): Promise<{ sha: string; content: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  return res.json() as Promise<{ sha: string; content: string }>;
}

async function ghPut(path: string, content: string, message: string, sha: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  return res.ok;
}

function urlToGithubPath(url: string, siteUrl: string): string | null {
  const path = url.replace(siteUrl, '');
  if (path.startsWith('/blog/')) {
    const slug = path.replace('/blog/', '');
    return `content/posts/${slug}.mdx`;
  }
  return null; // city/shop pages are in Supabase, not GitHub files
}

// ── Claude: generate specific fix for an issue ───────────────────────────────

interface ProposedFix {
  issue: AuditIssue;
  githubPath: string | null;
  originalContent: string;
  fixedContent: string;
  changeDescription: string;
}

async function generateFix(
  issue: AuditIssue,
  siteUrl: string
): Promise<ProposedFix | null> {
  const githubPath = urlToGithubPath(issue.page, siteUrl);

  if (!githubPath) {
    // Can't auto-fix Supabase or template pages yet — return as manual
    return null;
  }

  const file = await ghGet(githubPath);
  if (!file) return null;

  const originalContent = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf-8');

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are fixing an SEO issue in an MDX blog post.

ISSUE: ${issue.rule}
DETAIL: ${issue.detail}
FIX NEEDED: ${issue.fix}

CURRENT FILE CONTENT:
${originalContent}

Apply the fix to the file. Return the COMPLETE fixed file content — frontmatter + full body.
Do not truncate or summarize. Return ONLY the fixed file, no explanation.`,
    }],
  });

  const fixedContent = msg.content[0].type === 'text' ? msg.content[0].text.trim() : originalContent;

  if (fixedContent === originalContent) return null;

  return {
    issue,
    githubPath,
    originalContent,
    fixedContent,
    changeDescription: `seo: fix "${issue.rule}" on ${issue.page}`,
  };
}

// ── Prompt helper ─────────────────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function fixSite(report: AuditReport, opts: { yes?: boolean } = {}): Promise<void> {
  const fixable = report.issues.filter(i => i.autoFixable);
  const manual = report.issues.filter(i => !i.autoFixable);

  if (fixable.length === 0) {
    console.log('\nNo auto-fixable issues found. All issues require manual attention:');
    for (const i of manual) {
      console.log(`  • [${i.severity}] ${i.rule} — ${i.page}`);
      console.log(`    ${i.fix}`);
    }
    return;
  }

  console.log(`\n── Proposed Fixes (${fixable.length} auto-fixable) ──────────────────`);

  const proposals: ProposedFix[] = [];
  const skipped: AuditIssue[] = [];

  for (const issue of fixable) {
    logger.info('SiteFixer', `Generating fix: "${issue.rule}" on ${issue.page.replace(report.siteUrl, '') || '/'}`);
    const fix = await generateFix(issue, report.siteUrl);
    if (fix) {
      proposals.push(fix);
      console.log(`\n  ✓ ${fix.issue.page.replace(report.siteUrl, '') || '/'}`);
      console.log(`    Rule: ${fix.issue.rule}`);
      console.log(`    Change: ${fix.changeDescription}`);
    } else {
      skipped.push(issue);
      console.log(`\n  ⊘ ${issue.page.replace(report.siteUrl, '') || '/'} — ${issue.rule}`);
      console.log(`    (Requires manual fix: ${issue.fix})`);
    }
  }

  if (manual.length > 0) {
    console.log(`\n── Manual fixes required (${manual.length}) ──────────────────────`);
    for (const i of manual) {
      console.log(`  • [${i.severity}] ${i.rule}`);
      console.log(`    Page: ${i.page.replace(report.siteUrl, '') || '/'}`);
      console.log(`    ${i.fix}`);
    }
  }

  if (proposals.length === 0) {
    console.log('\nNo fixes could be generated automatically.');
    return;
  }

  console.log(`\n── Ready to apply ${proposals.length} fix${proposals.length > 1 ? 'es' : ''} ──`);
  const answer = opts.yes ? 'y' : await prompt('Apply fixes and commit to GitHub? (y/n): ');

  if (answer !== 'y' && answer !== 'yes') {
    console.log('Aborted — no changes made.');
    return;
  }

  let applied = 0;
  for (const fix of proposals) {
    logger.info('SiteFixer', `Committing: ${fix.githubPath}`);
    const file = await ghGet(fix.githubPath!);
    if (!file) { logger.warn('SiteFixer', `Could not re-fetch ${fix.githubPath}`); continue; }

    const ok = await ghPut(fix.githubPath!, fix.fixedContent, fix.changeDescription, file.sha);
    if (ok) {
      applied++;
      logger.success('SiteFixer', `Fixed: ${fix.githubPath}`);
    } else {
      logger.error('SiteFixer', `Failed to commit: ${fix.githubPath}`);
    }
  }

  console.log(`\n✓ Applied ${applied}/${proposals.length} fixes — Vercel deploying now.`);
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { analyzeSite } from './site-analyzer.js';
import { auditSite, printReport } from './site-auditor.js';

const isMain = typeof process !== 'undefined' && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  if (!url) { console.error('Usage: tsx src/stages/site-fixer.ts <url>'); process.exit(1); }

  (async () => {
    // Use cached audit report if it exists, otherwise run fresh audit
    let report: AuditReport;
    if (existsSync('audit-report.json')) {
      logger.info('SiteFixer', 'Loading cached audit-report.json…');
      report = JSON.parse(readFileSync('audit-report.json', 'utf-8')) as AuditReport;
    } else {
      logger.info('SiteFixer', 'No cached report found — running fresh audit…');
      const site = await analyzeSite(url);
      const { auditSite: audit } = await import('./site-auditor.js');
      report = await audit(site);
      printReport(report);
    }

    const yes = process.argv.includes('--yes') || process.argv.includes('-y');
    await fixSite(report, { yes });
  })().catch(err => { logger.error('SiteFixer', err.message); process.exit(1); });
}

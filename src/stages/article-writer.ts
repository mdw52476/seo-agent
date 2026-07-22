/**
 * Stage 4: Article Writer
 *
 * Pass 1 — Draft: streams a full ~3,000-4,000 word article from the content plan
 * Pass 2 — Reflection: fact-checks the draft, flags hallucinations, rewrites weak sections
 * Returns a finished Article ready for publishing
 */


import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../lib/logger.js';
import { analyzeSite } from './site-analyzer.js';
import { researchKeywords } from './keyword-researcher.js';
import { buildContentPlan } from './content-planner.js';
import type { SiteAnalysis, PlannedArticle, Article } from '../lib/types.js';

function buildContextBlock(layout: string, voice: string, skill: string): string {
  return [
    layout && `## Site Layout & Structure\n${layout}`,
    voice && `## Voice & Writing Style\n${voice}`,
    skill && `## AI-Tell Rules to Avoid\n${skill}\n\nThe rules above are requirements, not suggestions — this is not optional style guidance. Any rule labeled "PRIME DIRECTIVE" is absolute and non-negotiable, with zero exceptions outside of quoted dialogue. Before finalizing your output, re-read it specifically checking for violations of every PRIME DIRECTIVE rule (e.g. banned punctuation or words, sentence-structure limits) and correct every one you find.`,
  ].filter(Boolean).join('\n\n---\n\n');
}

function loadContextFiles(): { layout: string; voice: string; skill: string } {
  const read = (name: string) => {
    const p = join(process.cwd(), name);
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  };
  const layout = read('site-layout.md');
  const voice = read('voice-guide.md');
  // A site's own SKILL.md always wins; fall back to the tool's bundled default
  // so writing quality doesn't depend on the user having set one up yet.
  let skill = read('SKILL.md');
  if (!skill.trim()) {
    const defaultPath = join(process.cwd(), 'defaults', 'SKILL.md');
    skill = existsSync(defaultPath) ? readFileSync(defaultPath, 'utf-8') : '';
  }
  if (!layout) logger.warn('ArticleWriter', 'site-layout.md not found — run "fingerprint <url>" first');
  return { layout, voice, skill };
}

const client = new Anthropic();

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Pass 1: Draft ─────────────────────────────────────────────────────────────

const DRAFT_SYSTEM = `You are an expert SEO content writer. You write long-form, helpful,
authoritative articles tailored to the site's niche and audience. Your writing is:
- Conversational but informative
- Specific and concrete — real details, realistic ranges, actionable advice
- Structured with clear H2 and H3 headings
- Free of filler phrases like "In conclusion", "It's worth noting", or "Delve into"
- Never padded — every sentence adds value

Format: Return clean HTML using only these tags: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>, <table>, <tr>, <th>, <td>.
Do NOT include <html>, <head>, <body>, or <article> wrapper tags.`;

async function writeDraft(
  article: PlannedArticle,
  site: SiteAnalysis
): Promise<string> {
  logger.info('ArticleWriter', `Writing draft: "${article.title}"…`);

  const { layout, voice, skill } = loadContextFiles();
  const contextBlock = buildContextBlock(layout, voice, skill);

  const systemPrompt = contextBlock
    ? `${DRAFT_SYSTEM}\n\n---\n\n${contextBlock}`
    : DRAFT_SYSTEM;

  const sections = article.outline
    .map((s, i) => `Section ${i + 1}: ${s}`)
    .join('\n');

  const userContent = article.brief
    ? `Write a comprehensive 3,000-4,000 word SEO article based on the following brief:

ARTICLE BRIEF:
${article.brief}

Site niche: ${site.niche}
Site URL: ${site.url}
Site description: ${site.description}
Target audience: ${site.targetAudience}

Requirements:
- Generate an SEO-optimized title and use it as the implied H1 (do not output the H1 tag — start with the intro paragraph)
- Open with a strong 2-3 paragraph intro (no H2, straight into value)
- Create 5-7 H2 sections that best serve the brief's topic
- Each H2 section should be 300-500 words with at least one H3 sub-section
- Include a comparison table where relevant (pricing, options, features)
- End with a clear CTA relevant to the site's niche and linking back to ${site.url}
- Include 2-4 internal links to relevant pages on ${site.url} where appropriate
- The article must read as genuinely helpful to: ${site.targetAudience}

Write the full article now in clean HTML.`
    : `Write a comprehensive 3,000-4,000 word SEO article with the following spec:

Title: ${article.title}
Target keyword: "${article.keyword}"
Article type: ${article.articleType}
Site niche: ${site.niche}
Site URL: ${site.url}
Site description: ${site.description}
Target audience: ${site.targetAudience}

Required sections (use these as H2 headings, expand each fully):
${sections}

Requirements:
- Open with a strong 2-3 paragraph intro (no H2, straight into value)
- Each H2 section should be 300-500 words with at least one H3 sub-section
- Include a comparison table where relevant (pricing, options, features)
- Naturally use the target keyword and close variants 6-10 times total
- End with a clear CTA relevant to the site's niche and linking back to ${site.url}
- Include 2-4 internal links to relevant pages on ${site.url} where appropriate
- The article must read as genuinely helpful to someone in the target audience: ${site.targetAudience}

Write the full article now in clean HTML.`;

  let draft = '';

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  for await (const chunk of stream) {
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta.type === 'text_delta'
    ) {
      draft += chunk.delta.text;
      process.stdout.write('.');
    }
  }

  process.stdout.write('\n');
  logger.success('ArticleWriter', `Draft complete — ${countWords(draft)} words`);
  return draft;
}

// ── Pass 2: Reflection / Fact-check ──────────────────────────────────────────

const REFLECTION_SYSTEM = `You are a senior editor and SEO fact-checker.
Your job is to silently review and fix an AI-written HTML article.

CRITICAL: Return ONLY the corrected HTML — no audit notes, no commentary, no explanations, no markdown.
The very first character of your response must be a '<' HTML tag. Nothing before it.

Fix these problems if present:
1. Hallucinated facts (fake statistics, invented shop names, made-up prices)
2. Thin sections (under 250 words — expand them)
3. Keyword stuffing (keyword used awkwardly or too many times)
4. Missing local specificity
5. Weak or missing CTA`;

async function reflectAndRevise(
  draft: string,
  article: PlannedArticle,
  site: SiteAnalysis
): Promise<string> {
  logger.info('ArticleWriter', 'Running reflection pass…');

  const { layout, voice, skill } = loadContextFiles();
  const contextBlock = buildContextBlock(layout, voice, skill);

  const reflectionSystem = contextBlock
    ? `${REFLECTION_SYSTEM}\n\n---\n\n${contextBlock}`
    : REFLECTION_SYSTEM;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: reflectionSystem,
    messages: [
      {
        role: 'user',
        content: `Review and revise this article about "${article.keyword}" for the site ${site.url} (niche: ${site.niche}).

CHECKS TO PERFORM:
1. Flag any specific statistics, prices, or names that appear fabricated — replace with accurate general ranges or remove them
2. Ensure every H2 section is substantive (>250 words) — expand any thin sections
3. Confirm the target keyword "${article.keyword}" appears naturally 6-10 times
4. Verify the article genuinely serves "${site.targetAudience}" — add niche-specific context if missing
5. Ensure the final CTA is relevant to the site's niche and references ${site.url}
6. Re-scan specifically for violations of the AI-Tell Rules in the system prompt, especially any rule marked PRIME DIRECTIVE (e.g. banned punctuation or words, sentence-structure limits) — these must be fully corrected with zero exceptions outside quoted dialogue

ARTICLE TO REVIEW:
${draft}

Return the complete revised HTML article. If the article is already strong, return it unchanged.`,
      },
    ],
  });

  const revised =
    msg.content[0].type === 'text' ? msg.content[0].text : draft;

  // Strip markdown fences and any audit commentary before the first HTML tag
  let cleaned = revised.replace(/```html\n?|```/g, '').trim();
  const firstTag = cleaned.indexOf('<');
  if (firstTag > 0) cleaned = cleaned.slice(firstTag);
  logger.success(
    'ArticleWriter',
    `Reflection complete — ${countWords(cleaned)} words final`
  );
  return cleaned;
}

// ── Generate meta description ─────────────────────────────────────────────────

async function generateMeta(
  article: PlannedArticle,
  draft: string
): Promise<string> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [
      {
        role: 'user',
        content: `Write a single SEO meta description (150-160 characters) for this article.
Title: ${article.title}
Keyword: ${article.keyword}
First 300 chars of content: ${draft.replace(/<[^>]+>/g, '').slice(0, 300)}

Return ONLY the meta description text, no quotes, no explanation.`,
      },
    ],
  });
  return msg.content[0].type === 'text'
    ? msg.content[0].text.trim().slice(0, 160)
    : article.title;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function extractTitleFromHtml(html: string, fallback: string): string {
  const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, '').trim();
  const h2 = html.match(/<h2[^>]*>(.*?)<\/h2>/i);
  if (h2) return h2[1].replace(/<[^>]+>/g, '').trim();
  return fallback;
}

export async function writeArticle(
  article: PlannedArticle,
  site: SiteAnalysis
): Promise<Article> {
  const draft = await writeDraft(article, site);
  const revised = await reflectAndRevise(draft, article, site);
  const metaDescription = await generateMeta(article, revised);

  // When a brief was used, derive title from generated content
  const title = article.brief
    ? extractTitleFromHtml(revised, article.brief.slice(0, 80))
    : article.title;

  return {
    title,
    slug: toSlug(title),
    content: revised,
    metaDescription,
    keyword: article.keyword || title,
    wordCount: countWords(revised),
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  const articleIndex = parseInt(process.argv[3] ?? '0', 10);

  if (!url) {
    console.error('Usage: tsx src/stages/article-writer.ts <url> [article-index]');
    process.exit(1);
  }

  (async () => {
    const site = await analyzeSite(url);
    const keywords = await researchKeywords(site, { topN: 50 });
    const plans = await buildContentPlan(site, keywords, { weeksAhead: 1, articlesPerWeek: 3 });

    const allArticles = plans.flatMap((p) => p.articles);
    const target = allArticles[articleIndex];

    if (!target) {
      logger.error('ArticleWriter', `No article at index ${articleIndex}`);
      process.exit(1);
    }

    logger.info('ArticleWriter', `Writing article ${articleIndex}: "${target.title}"`);
    const article = await writeArticle(target, site);

    const outFile = `article-${article.slug}.html`;
    writeFileSync(
      outFile,
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${article.title}</title>
  <meta name="description" content="${article.metaDescription}">
</head>
<body>
  <h1>${article.title}</h1>
  ${article.content}
</body>
</html>`
    );

    console.log(`\n── Article Written ───────────────────────────────────`);
    console.log(`Title:       ${article.title}`);
    console.log(`Slug:        ${article.slug}`);
    console.log(`Keyword:     ${article.keyword}`);
    console.log(`Word count:  ${article.wordCount}`);
    console.log(`Meta:        ${article.metaDescription}`);
    console.log(`Saved to:    ${outFile}`);
  })().catch((err) => {
    logger.error('ArticleWriter', err.message);
    process.exit(1);
  });
}

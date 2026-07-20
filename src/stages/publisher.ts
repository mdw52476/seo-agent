/**
 * Stage 5: Publisher — GitHub Adapter
 *
 * Commits a finished article as an MDX file to the target GitHub repo.
 * Vercel detects the push and auto-deploys the site.
 *
 * Required env vars:
 *   GITHUB_TOKEN       — Personal Access Token with repo scope
 *   GITHUB_REPO        — e.g. your-username/your-repo
 *   GITHUB_BRANCH      — default: main
 *   GITHUB_CONTENT_PATH — default: content/posts
 */


import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { crawlPage } from '../lib/crawler.js';
import { logger } from '../lib/logger.js';
import type { Article } from '../lib/types.js';

const anthropic = new Anthropic();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_REPO = process.env.GITHUB_REPO ?? '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? 'main';
const GITHUB_CONTENT_PATH = process.env.GITHUB_CONTENT_PATH ?? 'content/posts';
const SITE_TYPE = (process.env.SITE_TYPE ?? 'nextjs') as 'nextjs' | 'html';

const GH_API = 'https://api.github.com';

// ── GitHub API helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries transient failures (network errors, 5xx) with exponential backoff —
// a bare 503 from GitHub's Content API shouldn't kill a whole publish run.
async function ghFetch(path: string, options: RequestInit = {}, retries = 3): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${GH_API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      const delay = 1000 * 2 ** attempt;
      logger.warn('Publisher', `GitHub request failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${delay}ms (${attempt + 1}/${retries})`);
      await sleep(delay);
      continue;
    }

    if (res.status >= 500 && attempt < retries) {
      const delay = 1000 * 2 ** attempt;
      logger.warn('Publisher', `GitHub returned ${res.status} — retrying in ${delay}ms (${attempt + 1}/${retries})`);
      await sleep(delay);
      continue;
    }

    return res;
  }
}

async function getFileSha(path: string): Promise<string | null> {
  const res = await ghFetch(
    `/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

async function commitFile(
  path: string,
  content: string,
  message: string,
  sha?: string | null
): Promise<string> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${path}: ${res.status} — ${err}`);
  }

  const data = (await res.json()) as { content: { html_url: string } };
  return data.content.html_url;
}

// ── MDX formatter ─────────────────────────────────────────────────────────────

function htmlToMdxBody(html: string): string {
  // The article content is already clean HTML from the writer.
  // We wrap it in an MDX-compatible way — raw HTML is valid in MDX.
  return html.trim();
}

function buildMdx(article: Article): string {
  const date = new Date().toISOString().slice(0, 10);
  return `---
title: "${article.title.replace(/"/g, '\\"')}"
date: "${date}"
keyword: "${article.keyword}"
description: "${article.metaDescription.replace(/"/g, '\\"')}"
wordCount: ${article.wordCount}
---

${htmlToMdxBody(article.content)}
`;
}

// ── HTML builder (for basic HTML sites) ──────────────────────────────────────

function buildHtml(article: Article): string {
  const date = new Date().toISOString().slice(0, 10);
  const title = article.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const desc  = article.metaDescription.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${desc}">
  <title>${title}</title>
</head>
<body>
  <article>
    <h1>${title}</h1>
    <p class="post-date">${date}</p>
    ${article.content}
  </article>
  <p><a href="/blog/">← Back to blog</a></p>
</body>
</html>
`;
}

// ── HTML blog index — scaffold + per-publish update ───────────────────────────

async function generateHtmlBlogIndex(siteUrl: string): Promise<string> {
  logger.info('Publisher', 'Generating HTML blog index page…');
  const layout = loadLayoutMd();

  let crawlSummary = '';
  try {
    const crawl = await crawlPage(siteUrl);
    crawlSummary = `URL: ${crawl.url}\nTitle: ${crawl.title}\nNav links: ${crawl.internalLinks.slice(0, 10).join(', ')}\nBody snippet: ${crawl.bodyText.slice(0, 1500)}`;
  } catch {
    logger.warn('Publisher', 'Could not crawl site for HTML index generation');
  }

  const prompt = `Generate a blog index HTML page for an HTML website.

${layout ? `## Site Layout Profile\n${layout}\n` : ''}
${crawlSummary ? `## Site Crawl Data\n${crawlSummary}\n` : ''}

Requirements:
- Match the site's visual style, nav structure, and color scheme from the crawl data above
- Include a nav bar that mirrors the site's existing navigation
- Include a section header "Blog" or "Articles"
- Include EXACTLY this HTML comment on its own line where the article list will go: <!-- ARTICLES_START -->
- Below the comment, include an empty <ul id="article-list" class="article-list"></ul>
- Include a footer that mirrors the site's existing footer if visible in crawl
- Inline CSS in a <style> tag that matches the site's design language
- Return ONLY the complete HTML document, no explanation`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0].type === 'text' ? msg.content[0].text : '';
  const cleaned = raw.replace(/```html\n?|```/g, '').trim();

  if (cleaned.includes('<!-- ARTICLES_START -->')) return cleaned;

  // Fallback if Claude didn't include the marker
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog</title>
  <style>body{font-family:sans-serif;max-width:760px;margin:0 auto;padding:2rem}ul{list-style:none;padding:0}.article-list li{border-bottom:1px solid #eee;padding:1.5rem 0}h2{margin:0 0 .25rem}p{color:#555;margin:.25rem 0}.date{font-size:.85rem;color:#999}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}</style>
</head>
<body>
  <nav><a href="/">← Home</a></nav>
  <h1>Blog</h1>
  <!-- ARTICLES_START -->
  <ul id="article-list" class="article-list"></ul>
</body>
</html>`;
}

async function updateHtmlBlogIndex(article: Article, siteUrl: string): Promise<void> {
  const indexPath = 'blog/index.html';
  const date = new Date().toISOString().slice(0, 10);
  const slug = article.slug;

  const newEntry = `  <li>
    <p class="date">${date}</p>
    <h2><a href="/blog/${slug}.html">${article.title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a></h2>
    <p>${article.metaDescription.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
  </li>`;

  const existingSha = await getFileSha(indexPath);

  if (!existingSha) {
    // First article — scaffold the index
    logger.info('Publisher', 'Creating blog/index.html…');
    const scaffold = await generateHtmlBlogIndex(siteUrl);
    const withEntry = scaffold.replace(
      '<!-- ARTICLES_START -->',
      `<!-- ARTICLES_START -->\n${newEntry}`
    );
    await commitFile(indexPath, withEntry, `chore: create blog index page`);
    return;
  }

  // Fetch and update existing index
  logger.info('Publisher', 'Updating blog/index.html…');
  const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${indexPath}?ref=${GITHUB_BRANCH}`);
  if (!res.ok) throw new Error(`Could not fetch ${indexPath}: ${res.status}`);
  const data = await res.json() as { content: string; sha: string };
  const current = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');

  if (!current.includes('<!-- ARTICLES_START -->')) {
    logger.warn('Publisher', 'blog/index.html missing <!-- ARTICLES_START --> marker — skipping update');
    return;
  }

  const updated = current.replace(
    '<!-- ARTICLES_START -->',
    `<!-- ARTICLES_START -->\n${newEntry}`
  );

  await commitFile(indexPath, updated, `content: add "${article.title}" to blog index`, data.sha);
  logger.success('Publisher', 'blog/index.html updated');
}

// ── Blog scaffold — Claude-generated to match site design ────────────────────

function loadLayoutMd(): string {
  const p = join(process.cwd(), 'site-layout.md');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

// posts.ts is always the same — it's a data utility, not a UI component
const POSTS_TS = `import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const POSTS_DIR = path.join(process.cwd(), 'content/posts');
const DIRECTORIES_DIR = path.join(process.cwd(), 'content/directories');

export interface PostMeta {
  slug: string;
  title: string;
  date: string;
  description: string;
  keyword: string;
  wordCount: number;
}

export interface Post extends PostMeta {
  content: string;
}

function getSlugsIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace(/\\.mdx$/, ''));
}

function getEntryIn(dir: string, slug: string): Post | null {
  const filePath = path.join(dir, \`\${slug}.mdx\`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  return {
    slug,
    title: data.title ?? slug,
    date: data.date ?? '',
    description: data.description ?? '',
    keyword: data.keyword ?? '',
    wordCount: data.wordCount ?? 0,
    content,
  };
}

export function getAllPostSlugs(): string[] {
  return getSlugsIn(POSTS_DIR);
}

export function getAllPosts(): PostMeta[] {
  return getAllPostSlugs()
    .map((slug) => getPost(slug))
    .filter((p): p is Post => p !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getPost(slug: string): Post | null {
  return getEntryIn(POSTS_DIR, slug);
}

export function getAllDirectorySlugs(): string[] {
  return getSlugsIn(DIRECTORIES_DIR);
}

export function getAllDirectories(): PostMeta[] {
  return getAllDirectorySlugs()
    .map((slug) => getDirectory(slug))
    .filter((p): p is Post => p !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getDirectory(slug: string): Post | null {
  return getEntryIn(DIRECTORIES_DIR, slug);
}
`;

async function generateBlogPages(siteUrl: string): Promise<{ blogIndex: string; blogSlug: string }> {
  logger.info('Publisher', 'Crawling site to generate matching blog page templates…');

  const layout = loadLayoutMd();

  // Crawl homepage to extract nav, color scheme, and component patterns
  let crawlSummary = '';
  try {
    const crawl = await crawlPage(siteUrl);
    crawlSummary = `
URL: ${crawl.url}
Title: ${crawl.title}
Nav items: ${crawl.internalLinks.slice(0, 10).join(', ')}
H1s: ${crawl.h1s.join(' | ')}
H2s: ${crawl.h2s.slice(0, 6).join(' | ')}
Schema types: ${crawl.schemaTypes.join(', ') || 'none'}
Body snippet: ${crawl.bodyText.slice(0, 2000)}
`.trim();
  } catch {
    logger.warn('Publisher', 'Could not crawl homepage — generating generic templates');
  }

  const prompt = `You are a Next.js 15 developer. Generate two TypeScript page components for a blog that matches an existing site's design.

${layout ? `## Site Layout Profile\n${layout}\n` : ''}
${crawlSummary ? `## Homepage Crawl Data\n${crawlSummary}\n` : ''}

Generate TWO files. Return them as a JSON object with exactly these keys:
- "blogIndex": the full content of src/app/blog/page.tsx
- "blogSlug": the full content of src/app/blog/[slug]/page.tsx

Requirements for both files:
- Use Next.js 15 App Router conventions (async params, generateStaticParams, generateMetadata)
- Import getAllPosts / getAllPostSlugs / getPost from '@/lib/posts'
- Match the site's visual style: colors, font weights, spacing, nav structure observed in the crawl
- Include a <nav> that matches the site's existing navigation items
- Use Tailwind CSS classes consistent with the site's design language
- blog/page.tsx: MUST call getAllPosts() at the top of the default export and map over the result — this is how new articles appear automatically when MDX files are added. Never hardcode post data.
- blog/[slug]/page.tsx: MUST use generateStaticParams() + getPost(slug) + render with <article dangerouslySetInnerHTML={{ __html: post.content }} />. Include BreadcrumbList JSON-LD schema.
- Do NOT import components that don't exist — only use built-in Next.js imports and @/lib/posts
- Do NOT fetch posts from an API or database — always use getAllPosts() / getPost() from @/lib/posts
- Return ONLY valid JSON, no markdown fences, no explanation`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0].type === 'text' ? msg.content[0].text : '';
  const cleaned = raw.replace(/```json\n?|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as { blogIndex: string; blogSlug: string };
    if (!parsed.blogIndex || !parsed.blogSlug) throw new Error('Missing keys');
    logger.success('Publisher', 'Blog page templates generated');
    return parsed;
  } catch {
    logger.warn('Publisher', 'Could not parse Claude response — falling back to generic templates');
    return {
      blogIndex: `import Link from 'next/link';
import { getAllPosts } from '@/lib/posts';

export const metadata = { title: 'Blog', description: 'Articles and guides.' };

export default function BlogPage() {
  const posts = getAllPosts();
  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-8">Blog</h1>
      <ul className="space-y-8">
        {posts.map((post) => (
          <li key={post.slug} className="border-b pb-8">
            <Link href={\`/blog/\${post.slug}\`}>
              <h2 className="text-xl font-semibold hover:text-blue-600">{post.title}</h2>
            </Link>
            <p className="text-sm text-gray-400 mt-1">{post.date}</p>
            <p className="text-gray-600 mt-2">{post.description}</p>
            <Link href={\`/blog/\${post.slug}\`} className="text-blue-500 text-sm mt-3 inline-block hover:underline">Read more →</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}`,
      blogSlug: `import { notFound } from 'next/navigation';
import { getAllPostSlugs, getPost } from '@/lib/posts';
import type { Metadata } from 'next';

interface Props { params: Promise<{ slug: string }> }

export async function generateStaticParams() {
  return getAllPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return { title: post.title, description: post.description };
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();
  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">{post.title}</h1>
      <p className="text-sm text-gray-400 mb-8">{post.date}</p>
      <article className="prose prose-gray max-w-none" dangerouslySetInnerHTML={{ __html: post.content }} />
    </main>
  );
}`,
    };
  }
}

async function ensureBlogScaffold(siteUrl: string): Promise<void> {
  logger.info('Publisher', 'Checking blog scaffold…');

  const needsGeneration =
    !(await getFileSha('src/app/blog/page.tsx')) ||
    !(await getFileSha('src/app/blog/[slug]/page.tsx'));

  // posts.ts — always commit if missing (no design dependency)
  const postsTsSha = await getFileSha('src/lib/posts.ts');
  if (!postsTsSha) {
    logger.info('Publisher', '  Creating src/lib/posts.ts…');
    await commitFile('src/lib/posts.ts', POSTS_TS, 'chore: add blog posts helper');
  } else {
    logger.info('Publisher', '  src/lib/posts.ts — already exists, skipping');
  }

  // content/posts/.gitkeep
  const gitkeepSha = await getFileSha('content/posts/.gitkeep');
  if (!gitkeepSha) {
    await commitFile('content/posts/.gitkeep', '', 'chore: create content/posts directory');
  }

  // Blog pages — generate with Claude if either is missing
  if (needsGeneration) {
    const { blogIndex, blogSlug } = await generateBlogPages(siteUrl);

    const indexSha = await getFileSha('src/app/blog/page.tsx');
    if (!indexSha) {
      logger.info('Publisher', '  Creating src/app/blog/page.tsx…');
      await commitFile('src/app/blog/page.tsx', blogIndex, 'chore: add blog index page (design-matched)');
    }

    const slugSha = await getFileSha('src/app/blog/[slug]/page.tsx');
    if (!slugSha) {
      logger.info('Publisher', '  Creating src/app/blog/[slug]/page.tsx…');
      await commitFile('src/app/blog/[slug]/page.tsx', blogSlug, 'chore: add blog post page (design-matched)');
    }
  } else {
    logger.info('Publisher', '  Blog pages already exist — skipping generation');
  }

  logger.success('Publisher', 'Blog scaffold ready');
}

// ── Sitemap — Next.js: dynamic scaffold (one-time); HTML: static, updated per-publish ─

function buildSitemapTs(siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, '');
  return `import type { MetadataRoute } from 'next';
import { getAllPosts, getAllDirectories } from '@/lib/posts';

const SITE_URL = '${base}';

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();
  const directories = getAllDirectories();

  return [
    { url: SITE_URL, lastModified: new Date() },
    { url: \`\${SITE_URL}/blog\`, lastModified: new Date() },
    ...posts.map((p) => ({ url: \`\${SITE_URL}/blog/\${p.slug}\`, lastModified: p.date ? new Date(p.date) : new Date() })),
    ...directories.map((d) => ({ url: \`\${SITE_URL}/directories/\${d.slug}\`, lastModified: d.date ? new Date(d.date) : new Date() })),
  ];
}
`;
}

async function ensureSitemap(siteUrl: string): Promise<void> {
  const sha = await getFileSha('src/app/sitemap.ts');
  if (sha) {
    logger.info('Publisher', '  src/app/sitemap.ts — already exists, skipping');
    return;
  }
  logger.info('Publisher', '  Creating src/app/sitemap.ts…');
  await commitFile('src/app/sitemap.ts', buildSitemapTs(siteUrl), 'chore: add dynamic sitemap.ts');
  logger.success('Publisher', '  sitemap.ts created — updates automatically as posts/directories are published');
}

const SITEMAP_XML_PATH = 'sitemap.xml';

function buildSitemapXmlScaffold(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<!-- URLS_START -->
</urlset>
`;
}

async function updateHtmlSitemap(pageUrl: string, lastmod: string): Promise<void> {
  const urlEntry = `  <url>\n    <loc>${pageUrl}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
  const existingSha = await getFileSha(SITEMAP_XML_PATH);

  if (!existingSha) {
    logger.info('Publisher', 'Creating sitemap.xml…');
    const scaffold = buildSitemapXmlScaffold().replace('<!-- URLS_START -->', `<!-- URLS_START -->\n${urlEntry}`);
    await commitFile(SITEMAP_XML_PATH, scaffold, 'chore: create sitemap.xml');
    return;
  }

  const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${SITEMAP_XML_PATH}?ref=${GITHUB_BRANCH}`);
  if (!res.ok) throw new Error(`Could not fetch ${SITEMAP_XML_PATH}: ${res.status}`);
  const data = await res.json() as { content: string; sha: string };
  const current = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');

  if (!current.includes('<!-- URLS_START -->')) {
    logger.warn('Publisher', 'sitemap.xml missing <!-- URLS_START --> marker — skipping update');
    return;
  }
  if (current.includes(`<loc>${pageUrl}</loc>`)) {
    logger.info('Publisher', 'sitemap.xml already contains this URL — skipping');
    return;
  }

  const updated = current.replace('<!-- URLS_START -->', `<!-- URLS_START -->\n${urlEntry}`);
  await commitFile(SITEMAP_XML_PATH, updated, `chore: add ${pageUrl} to sitemap`, data.sha);
  logger.success('Publisher', 'sitemap.xml updated');
}

// ── Main publish function ─────────────────────────────────────────────────────

export interface PublishResult {
  url: string;
  filePath: string;
  isNew: boolean;
}

export async function publishArticle(article: Article, opts: { contentPath?: string; siteType?: 'nextjs' | 'html'; siteUrl?: string } = {}): Promise<PublishResult> {
  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set — add it in Site Settings');
  }
  if (!GITHUB_REPO) {
    throw new Error('GITHUB_REPO is not set — add it in Site Settings (e.g. owner/repo)');
  }
  logger.info('Publisher', `Target repo: ${GITHUB_REPO} branch: ${GITHUB_BRANCH}`);

  const contentPath = opts.contentPath ?? GITHUB_CONTENT_PATH;
  const siteUrl = opts.siteUrl ?? process.env.SITE_URL ?? '';
  const isHtmlSite = (opts.siteType ?? SITE_TYPE) === 'html';
  const isDirectory = contentPath !== GITHUB_CONTENT_PATH;
  const pageUrl = `${siteUrl.replace(/\/$/, '')}/${isDirectory ? 'directories' : 'blog'}/${article.slug}`;
  const lastmod = new Date().toISOString().slice(0, 10);

  if (isHtmlSite) {
    // HTML sites: update the blog index on every publish
    await updateHtmlBlogIndex(article, siteUrl);
    await updateHtmlSitemap(pageUrl, lastmod);
  } else {
    // Next.js sites: scaffold blog pages on first publish only
    if (contentPath === GITHUB_CONTENT_PATH) await ensureBlogScaffold(siteUrl);
    // sitemap.ts is dynamic (reads getAllPosts/getAllDirectories at request time), so it
    // only ever needs to be scaffolded once — after that it stays current automatically.
    await ensureSitemap(siteUrl);
  }

  const ext = isHtmlSite ? 'html' : 'mdx';
  const fileName = `${article.slug}.${ext}`;
  const filePath = `${contentPath}/${fileName}`;
  const fileContent = isHtmlSite ? buildHtml(article) : buildMdx(article);

  logger.info('Publisher', `Publishing "${article.title}" → ${filePath}`);

  const existingSha = await getFileSha(filePath);
  const isNew = !existingSha;

  const url = await commitFile(
    filePath,
    fileContent,
    `content: ${isNew ? 'add' : 'update'} "${article.title}"`,
    existingSha
  );

  logger.success(
    'Publisher',
    `${isNew ? 'Published' : 'Updated'}: ${url}`
  );

  return { url, filePath, isNew };
}

// ── Migrate city-directory posts → content/directories ───────────────────────

const CITY_DIR_RE = /\b(best|top|cheapest|nearest)\b.{2,35}\b(in|near)\b/i;

export interface MigrateResult {
  moved: string[];
  skipped: string[];
  errors: string[];
}

async function listFolder(folderPath: string): Promise<{ name: string; sha: string; download_url: string }[]> {
  const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${folderPath}?ref=${GITHUB_BRANCH}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub LIST ${folderPath}: ${res.status}`);
  const data = await res.json() as { name: string; sha: string; download_url: string; type: string }[];
  return data.filter(f => f.type === 'file' && (f.name.endsWith('.mdx') || f.name.endsWith('.md') || f.name.endsWith('.html')));
}

async function getFileContent(downloadUrl: string): Promise<string> {
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return res.text();
}

async function deleteFile(path: string, sha: string, message: string): Promise<void> {
  const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: GITHUB_BRANCH }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub DELETE ${path}: ${res.status} — ${err}`);
  }
}

function extractTitleFromFrontmatter(content: string): string {
  const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return match ? match[1] : '';
}

export async function migrateDirs(opts: {
  fromPath?: string;
  toPath?: string;
} = {}): Promise<MigrateResult> {
  const fromPath = opts.fromPath ?? GITHUB_CONTENT_PATH;
  const toPath   = opts.toPath   ?? (process.env.GITHUB_DIRECTORY_PATH ?? 'content/directories');

  logger.info('Publisher', `Scanning ${fromPath} for city-directory articles…`);

  const files = await listFolder(fromPath);
  logger.info('Publisher', `Found ${files.length} file(s) in ${fromPath}`);

  const result: MigrateResult = { moved: [], skipped: [], errors: [] };

  for (const file of files) {
    try {
      const content = await getFileContent(file.download_url);
      const title = extractTitleFromFrontmatter(content);

      if (!CITY_DIR_RE.test(title) && !CITY_DIR_RE.test(file.name)) {
        logger.info('Publisher', `  Skipping (not a directory): ${file.name}`);
        result.skipped.push(file.name);
        continue;
      }

      logger.info('Publisher', `  Moving: ${file.name} → ${toPath}/`);

      // Write to destination
      const destPath = `${toPath}/${file.name}`;
      const existingSha = await getFileSha(destPath);
      await commitFile(destPath, content, `chore: migrate directory article — ${file.name}`, existingSha);

      // Delete from source
      await deleteFile(`${fromPath}/${file.name}`, file.sha, `chore: remove from posts (migrated to ${toPath}) — ${file.name}`);

      logger.success('Publisher', `  Moved: ${file.name}`);
      result.moved.push(file.name);

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Publisher', `  Error on ${file.name}: ${msg}`);
      result.errors.push(`${file.name}: ${msg}`);
    }
  }

  logger.success('Publisher', `Migration complete — ${result.moved.length} moved, ${result.skipped.length} skipped, ${result.errors.length} errors`);
  return result;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import { analyzeSite } from './site-analyzer.js';
import { researchKeywords } from './keyword-researcher.js';
import { buildContentPlan } from './content-planner.js';
import { writeArticle } from './article-writer.js';

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  const idx = parseInt(process.argv[3] ?? '0', 10);

  if (!url) {
    console.error('Usage: tsx src/stages/publisher.ts <url> [article-index]');
    process.exit(1);
  }

  (async () => {
    const site = await analyzeSite(url);
    const keywords = await researchKeywords(site, { topN: 50 });
    const plans = await buildContentPlan(site, keywords, { weeksAhead: 1, articlesPerWeek: 3 });
    const allArticles = plans.flatMap((p) => p.articles);
    const target = allArticles[idx];
    if (!target) { logger.error('Publisher', `No article at index ${idx}`); process.exit(1); }

    const article = await writeArticle(target, site);
    const result = await publishArticle(article);

    console.log(`\n── Published ─────────────────────────────────────────`);
    console.log(`File:   ${result.filePath}`);
    console.log(`URL:    ${result.url}`);
    console.log(`Status: ${result.isNew ? 'New article' : 'Updated existing'}`);
    console.log(`\nYour site will deploy automatically within ~30 seconds.`);
    console.log(`Live at: ${result.url}`);
  })().catch((err) => {
    logger.error('Publisher', err.message);
    process.exit(1);
  });
}

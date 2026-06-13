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


import { logger } from '../lib/logger.js';
import type { Article } from '../lib/types.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_REPO = process.env.GITHUB_REPO ?? '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? 'main';
const GITHUB_CONTENT_PATH = process.env.GITHUB_CONTENT_PATH ?? 'content/posts';
const SITE_TYPE = (process.env.SITE_TYPE ?? 'nextjs') as 'nextjs' | 'html';

const GH_API = 'https://api.github.com';

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function ghFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
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
</body>
</html>
`;
}

// ── Blog scaffold ─────────────────────────────────────────────────────────────
// Commits the blog pages and lib/posts.ts if they don't exist yet.

const BLOG_FILES: Record<string, string> = {
  'src/lib/posts.ts': `import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const POSTS_DIR = path.join(process.cwd(), 'content/posts');

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

export function getAllPostSlugs(): string[] {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace(/\\.mdx$/, ''));
}

export function getAllPosts(): PostMeta[] {
  return getAllPostSlugs()
    .map((slug) => getPost(slug))
    .filter((p): p is Post => p !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getPost(slug: string): Post | null {
  const filePath = path.join(POSTS_DIR, \`\${slug}.mdx\`);
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
`,

  'src/app/blog/page.tsx': `import Link from 'next/link';
import { getAllPosts } from '@/lib/posts';

export const metadata = {
  title: 'Blog',
  description: 'Articles, guides, and directories.',
};

export default function BlogPage() {
  const posts = getAllPosts();

  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Blog</h1>
      <p className="text-gray-500 mb-10">
        Articles, guides, and resources.
      </p>
      {posts.length === 0 ? (
        <p className="text-gray-400">No posts yet — check back soon.</p>
      ) : (
        <ul className="space-y-8">
          {posts.map((post) => (
            <li key={post.slug} className="border-b pb-8">
              <Link href={\`/blog/\${post.slug}\`} className="group">
                <h2 className="text-xl font-semibold group-hover:text-blue-600 transition-colors">
                  {post.title}
                </h2>
              </Link>
              <p className="text-sm text-gray-400 mt-1">{post.date}</p>
              <p className="text-gray-600 mt-2">{post.description}</p>
              <Link
                href={\`/blog/\${post.slug}\`}
                className="text-blue-500 text-sm mt-3 inline-block hover:underline"
              >
                Read more →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
`,

  'src/app/blog/[slug]/page.tsx': `import { notFound } from 'next/navigation';
import { getAllPostSlugs, getPost } from '@/lib/posts';
import type { Metadata } from 'next';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return getAllPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
  };
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">{post.title}</h1>
      <p className="text-sm text-gray-400 mb-8">{post.date}</p>
      <article
        className="prose prose-gray max-w-none"
        dangerouslySetInnerHTML={{ __html: post.content }}
      />
    </main>
  );
}
`,

  'content/posts/.gitkeep': '',
};

async function ensureBlogScaffold(): Promise<void> {
  logger.info('Publisher', 'Checking blog scaffold…');

  for (const [filePath, content] of Object.entries(BLOG_FILES)) {
    const sha = await getFileSha(filePath);
    if (sha) {
      logger.info('Publisher', `  ${filePath} — already exists, skipping`);
      continue;
    }
    logger.info('Publisher', `  Creating ${filePath}…`);
    await commitFile(
      filePath,
      content,
      `chore: add blog scaffold — ${filePath}`
    );
  }

  // Add gray-matter dependency note (user must run npm install)
  logger.success('Publisher', 'Blog scaffold committed');
}

// ── Main publish function ─────────────────────────────────────────────────────

export interface PublishResult {
  url: string;
  filePath: string;
  isNew: boolean;
}

export async function publishArticle(article: Article, opts: { contentPath?: string; siteType?: 'nextjs' | 'html' } = {}): Promise<PublishResult> {
  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set — add it in Site Settings');
  }
  if (!GITHUB_REPO) {
    throw new Error('GITHUB_REPO is not set — add it in Site Settings (e.g. owner/repo)');
  }
  logger.info('Publisher', `Target repo: ${GITHUB_REPO} branch: ${GITHUB_BRANCH}`);

  const contentPath = opts.contentPath ?? GITHUB_CONTENT_PATH;

  // Only scaffold blog for the standard posts path
  if (contentPath === GITHUB_CONTENT_PATH) {
    await ensureBlogScaffold();
  }

  const isHtml = (opts.siteType ?? SITE_TYPE) === 'html';
  const ext = isHtml ? 'html' : 'mdx';
  const fileName = `${article.slug}.${ext}`;
  const filePath = `${contentPath}/${fileName}`;
  const fileContent = isHtml ? buildHtml(article) : buildMdx(article);

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

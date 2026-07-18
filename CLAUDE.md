# SEO Agent — Claude Code Guidelines

## What This Is
A fully automated SEO content pipeline that goes from site analysis → keyword research → content planning → AI writing → GitHub publishing. Managed via a web dashboard (`seo-agent-web`) deployed on Railway.

There are two repos:
- `mdw52476/seo-agent` — this repo, the CLI agent (TypeScript)
- `mdw52476/seo-agent-web` — the Next.js web dashboard at `C:\Users\mdw52\seo-agent-web`

## Architecture

### Pipeline Stages
```
analyze   → site-analyzer.ts     — crawls site, writes site-profile.json + site-layout.md
research  → keyword-researcher.ts — generates + scores ~50 keywords via Claude
serp      → serp-researcher.ts    — crawls competitor pages, finds content gaps
plan      → content-planner.ts    — builds weekly editorial calendar with varied article types
write     → article-writer.ts     — 2-pass draft + reflection (Sonnet), meta (Haiku)
publish   → publisher.ts          — commits MDX/HTML to GitHub, scaffolds blog on first run
audit     → site-auditor.ts       — crawls all pages, scores SEO issues by severity
fix       → site-fixer.ts         — auto-applies fixes from last audit report
```

### CLI Commands
```bash
analyze <url>                        # Stage 1: profile site, generate site-layout.md
fingerprint <url>                    # Refresh site-layout.md only (use after redesign)
research <url>                       # Stage 2: keyword research
plan <url>                           # Stage 3: content calendar
publish <url> [--count N]            # Full pipeline: research → plan → write → publish
publish <url> --brief "topic/spec"   # Skip research, write directly to user's spec
publish-dir <url> [--count N]        # Publish city/directory articles
audit <url>                          # SEO audit report → audit-report.json
fix <url> [--yes]                    # Apply fixes from audit-report.json
day-guide <url> [--cycle N]          # Plan 30-day content guide
log                                  # Show all published articles
```

## Per-Site Files
Three files are written to the agent root directory for each site:

| File | Owner | Purpose |
|------|-------|---------|
| `site-profile.json` | Agent (auto) | Business context — niche, audience, products. Cached 30 days |
| `site-layout.md` | Agent (auto) | Layout fingerprint — title patterns, H2 structure, schema types, nav, URL format, tone |
| `voice-guide.md` | User (manual) | Writing tone, style, vocabulary preferences |
| `SKILL.md` | User (manual) | AI-tell patterns to eliminate from drafts |

`site-layout.md` and both skill files are injected into the article writer's system prompt before every draft. The agent never overwrites `voice-guide.md` or `SKILL.md`.

## Article Writer (article-writer.ts)
Two-pass process:
1. **Draft** — Claude Sonnet streams 3,000-4,000 word article. Reads `site-layout.md`, `voice-guide.md`, `SKILL.md` and injects all three into the system prompt.
2. **Reflection** — Sonnet reviews draft for hallucinations, thin sections, keyword stuffing, weak CTA. Same context files injected.
3. **Meta** — Haiku generates 150-160 char meta description.

When `brief` is set on a `PlannedArticle`, the outline is ignored and Claude writes freely to the brief. Title is extracted from the generated H1.

## Publisher (publisher.ts)

### Next.js sites
On first publish, checks if `src/app/blog/page.tsx` and `src/app/blog/[slug]/page.tsx` exist. If not, calls Claude to generate design-matched versions by:
- Reading `site-layout.md`
- Crawling the live homepage for nav structure and styling
- Generating components that match the site's actual design

`src/lib/posts.ts` is always the same (data utility, no design dependency).

Blog index updates automatically — `getAllPosts()` reads the filesystem, so new MDX files appear on deployment with no manual index update needed.

### HTML sites
- Each article is a standalone `.html` file with a `← Back to blog` link
- `blog/index.html` is scaffolded on first publish (Claude-generated, design-matched)
- Every subsequent publish prepends a new `<li>` entry after the `<!-- ARTICLES_START -->` marker in the index
- Index is fetched from GitHub, updated, and recommitted on each publish

## Site Analyzer (site-analyzer.ts)
Two outputs per run:

**`site-profile.json`** — business context (existing behavior):
```json
{ "description", "niche", "targetAudience", "products", "topCompetitorUrls", "analyzedAt" }
```

**`site-layout.md`** — layout fingerprint (added recently):
- Crawls homepage + `/blog` + `/ohio` (best-effort)
- Extracts: title pattern, meta pattern, URL format, H2 count, word count range, schema types, nav items, internal linking patterns, CTA placement, writing tone
- Written by Claude Sonnet, stored as markdown
- Re-generated on every fresh `analyze` run
- Can be refreshed standalone with `fingerprint <url>`

## Web Dashboard (seo-agent-web)
The dashboard at `C:\Users\mdw52\seo-agent-web` spawns the CLI as a child process via `/api/run/route.ts` and streams stdout as Server-Sent Events to the browser.

Key UI sections:
- **Pipeline** — stage runner buttons (analyze → research → plan → publish)
- **Articles** — published article list + brief textarea for user-specified topics
- **Directories** — directory article list
- **Skills** — three sections:
  - Site Layout Profile (read-only, shows `site-layout.md`, "Refresh Site Layout" button)
  - Voice Guide (`voice-guide.md`, user-editable, upload or type)
  - AI-Tells Rules (`SKILL.md`, user-editable, upload or type)
- **Audit** — SEO audit report viewer
- **Settings** — GitHub token, repo, content path, site type (nextjs/html)

## Environment Variables (per site .env)
```
ANTHROPIC_API_KEY=
GITHUB_TOKEN=
GITHUB_REPO=owner/repo
GITHUB_BRANCH=main
GITHUB_CONTENT_PATH=content/posts
GITHUB_DIRECTORY_PATH=content/directories
SITE_URL=https://yoursite.com
SITE_TYPE=nextjs|html
SITE_ID=uuid
SUPABASE_URL=
SUPABASE_ANON_KEY=
```

## Supabase Tables
| Table | Purpose |
|-------|---------|
| `sites` | Site metadata, env vars, profile JSON |
| `articles` | Published article log |
| `audit_reports` | SEO audit results |
| `content_plans` | 30-day content guides |

## Models Used
- **Claude Sonnet** — article drafting, reflection, site analysis, layout fingerprinting, scaffold generation
- **Claude Haiku** — keyword seed generation, keyword scoring, meta description generation, SERP gap analysis

## What NOT to Do
- Never overwrite `voice-guide.md` or `SKILL.md` — user owns these
- Never skip the `site-layout.md` injection in article-writer — it's what makes articles match the site
- Never hardcode blog scaffold templates — always generate via Claude using the site crawl
- The `published.json` log prevents re-publishing the same keyword — don't bypass it

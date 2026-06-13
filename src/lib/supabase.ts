
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_ANON_KEY ?? '';

export const supabase = url && key
  ? createClient(url, key, { realtime: { transport: ws } })
  : null;

export async function logArticle(entry: {
  siteId: string;
  keyword: string;
  slug: string;
  title: string;
  url: string;
  articleType: 'article' | 'directory';
}) {
  if (!supabase) { console.error('[Supabase] client is null — SUPABASE_URL/ANON_KEY missing'); return; }
  if (!entry.siteId) { console.error('[Supabase] logArticle: siteId is empty — SITE_ID env var not set'); return; }
  const { error } = await supabase.from('articles').insert({
    site_id:      entry.siteId,
    keyword:      entry.keyword,
    slug:         entry.slug,
    title:        entry.title,
    url:          entry.url,
    article_type: entry.articleType,
  });
  if (error) console.error('[Supabase] logArticle failed:', error.message);
}

export async function logSiteProfile(profile: Record<string, unknown>) {
  if (!supabase) return;
  const siteId = process.env.SITE_ID ?? '';
  if (!siteId) return;
  await supabase.from('sites').update({ profile }).eq('id', siteId);
}

export async function logAuditReport(report: {
  siteId: string;
  score: number;
  pagesChecked: number;
  issues: unknown[];
}) {
  if (!supabase) return;
  await supabase.from('audit_reports').insert({
    site_id:       report.siteId,
    score:         report.score,
    pages_checked: report.pagesChecked,
    issues:        report.issues,
  });
}

export async function logContentPlan(entry: {
  siteId: string;
  cycle: number;
  days: unknown[];
}) {
  if (!supabase) return;
  await supabase.from('content_plans').upsert({
    site_id: entry.siteId,
    cycle:   entry.cycle,
    days:    entry.days,
  }, { onConflict: 'site_id,cycle' });
}

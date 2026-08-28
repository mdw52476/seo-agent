
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const url = process.env.SUPABASE_URL ?? '';
// Service role key bypasses RLS -- required since this client has no user session
// (it's a trusted backend process the dashboard already scoped to a single SITE_ID,
// not an end-user request). Falls back to the anon key only so the client isn't
// null if the service key isn't configured yet; writes will still fail under RLS
// in that case.
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

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
  if (!supabase) { console.error('[Supabase] client is null — SUPABASE_URL/ANON_KEY missing'); return; }
  const siteId = process.env.SITE_ID ?? '';
  if (!siteId) { console.error('[Supabase] logSiteProfile: SITE_ID env var not set'); return; }
  const { error } = await supabase.from('sites').update({ profile }).eq('id', siteId);
  if (error) console.error('[Supabase] logSiteProfile failed:', error.message);
}

export async function logAuditReport(report: {
  siteId: string;
  score: number;
  pagesChecked: number;
  issues: unknown[];
}) {
  if (!supabase) { console.error('[Supabase] client is null — SUPABASE_URL/ANON_KEY missing'); return; }
  if (!report.siteId) { console.error('[Supabase] logAuditReport: siteId is empty — SITE_ID env var not set'); return; }
  const { error } = await supabase.from('audit_reports').insert({
    site_id:       report.siteId,
    score:         report.score,
    pages_checked: report.pagesChecked,
    issues:        report.issues,
  });
  if (error) console.error('[Supabase] logAuditReport failed:', error.message);
}

export async function logContentPlan(entry: {
  siteId: string;
  cycle: number;
  days: unknown[];
}) {
  if (!supabase) { console.error('[Supabase] client is null — SUPABASE_URL/ANON_KEY missing'); return; }
  if (!entry.siteId) { console.error('[Supabase] logContentPlan: siteId is empty — SITE_ID env var not set'); return; }
  const { error } = await supabase.from('content_plans').upsert({
    site_id: entry.siteId,
    cycle:   entry.cycle,
    days:    entry.days,
  }, { onConflict: 'site_id,cycle' });
  if (error) console.error('[Supabase] logContentPlan failed:', error.message);
}

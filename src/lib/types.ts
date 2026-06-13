export interface SiteAnalysis {
  url: string;
  title: string;
  description: string;
  niche: string;
  targetAudience: string;
  products: string[];
  topCompetitorUrls: string[];
  analyzedAt: string;
}

export interface Keyword {
  id?: number;
  keyword: string;
  searchVolume: number;
  difficulty: number;
  score: number;
  articleType: ArticleType;
  status: 'pending' | 'planned' | 'written' | 'published';
  siteUrl: string;
}

export type ArticleType =
  | 'listicle'
  | 'how-to'
  | 'vs'
  | 'news'
  | 'qa'
  | 'roundup'
  | 'review';

export interface ContentPlan {
  id?: number;
  weekOf: string;
  siteUrl: string;
  articles: PlannedArticle[];
}

export interface PlannedArticle {
  id?: number;
  keyword: string;
  title: string;
  articleType: ArticleType;
  outline: string[];
  status: 'planned' | 'writing' | 'written' | 'published';
  publishedUrl?: string;
}

export interface Article {
  title: string;
  slug: string;
  content: string;
  metaDescription: string;
  keyword: string;
  wordCount: number;
}

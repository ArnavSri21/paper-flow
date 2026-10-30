import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Enable CORS for API endpoints so the Android APK WebView and web client can access them
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getBaseUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// ── AI-SUMMARIZED TECH & AI NEWS ENGINE (GEMINI 3.8 FLASH + GOOGLE SEARCH GROUNDING) ──
const NEWS_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // Refresh every 15 minutes
let aiTechNewsState = {
  items: [],
  lastUpdated: 0,
  isRefreshing: false,
  groundingSources: [],
};

function makeDeterministicNewsId(title, url) {
  const raw = `${String(url || '').trim().toLowerCase()}|${String(title || '').trim().toLowerCase()}`;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 14);
  return `__ainews__${hash}`;
}

function extractDomainName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    const parts = host.split('.');
    if (parts.length >= 2) {
      const main = parts[parts.length - 2];
      const map = {
        techcrunch: 'TechCrunch',
        theverge: 'The Verge',
        arstechnica: 'Ars Technica',
        wired: 'Wired',
        technologyreview: 'MIT Technology Review',
        venturebeat: 'VentureBeat',
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google AI',
        deepmind: 'Google DeepMind',
        microsoft: 'Microsoft',
        nvidia: 'NVIDIA',
        github: 'GitHub',
        huggingface: 'Hugging Face',
        ieee: 'IEEE Spectrum',
        reuters: 'Reuters Tech',
        bloomberg: 'Bloomberg Tech',
        bbc: 'BBC Tech',
        nytimes: 'NYT Tech',
        engadget: 'Engadget',
        zdnet: 'ZDNET',
        tomshardware: "Tom's Hardware",
      };
      if (map[main.toLowerCase()]) return map[main.toLowerCase()];
      return main.charAt(0).toUpperCase() + main.slice(1);
    }
    return host;
  } catch (e) {
    return 'Tech Source';
  }
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlTags(html) {
  if (!html) return '';
  return decodeHtmlEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

async function fetchArticleExcerptAndDiscussion(seed) {
  let metaDesc = '';
  const bodyParagraphs = [];
  const discussionInsights = [];

  // 1. Try fetching the source article HTML for meta description & lead paragraphs
  if (seed.url && !/\.(pdf|zip|mp4|mov|png|jpg)$/i.test(seed.url)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2800);
      const res = await fetch(seed.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; PaperFlowNewsReader/1.0; +https://paperflow.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) {
          const html = (await res.text()).slice(0, 140000);
          const ogMatch =
            html.match(
              /<meta[^>]+(?:property|name)=["'](?:og:description|twitter:description|description)["'][^>]+content=["']([^"']{35,600})["']/i
            ) ||
            html.match(
              /<meta[^>]+content=["']([^"']{35,600})["'][^>]+(?:property|name)=["'](?:og:description|twitter:description|description)["']/i
            );
          if (ogMatch && ogMatch[1]) {
            metaDesc = decodeHtmlEntities(ogMatch[1]);
          }

          const pRegex = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
          let match;
          while ((match = pRegex.exec(html)) !== null && bodyParagraphs.length < 4) {
            const cleaned = stripHtmlTags(match[1]).replace(/\s+/g, ' ').trim();
            if (
              cleaned.length >= 95 &&
              cleaned.length <= 650 &&
              !/cookie|privacy policy|terms of service|subscribe to our|sign up for|all rights reserved|enable javascript/i.test(
                cleaned
              )
            ) {
              if (!bodyParagraphs.includes(cleaned) && cleaned !== metaDesc) {
                bodyParagraphs.push(cleaned);
              }
            }
          }
        }
      }
    } catch (e) {
      // Ignore individual article fetch timeout
    }
  }

  // 2. Also pull top technical commentary from HN Algolia item API if objectID is available
  if (seed.objectID && bodyParagraphs.length < 2) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2200);
      const hnRes = await fetch(`https://hn.algolia.com/api/v1/items/${seed.objectID}`, {
        headers: { 'User-Agent': 'PaperFlow-NewsBot/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (hnRes.ok) {
        const hnData = await hnRes.json();
        if (hnData && Array.isArray(hnData.children)) {
          for (const child of hnData.children) {
            if (!child || !child.text) continue;
            const cleaned = stripHtmlTags(child.text).replace(/\s+/g, ' ').trim();
            if (cleaned.length >= 90 && discussionInsights.length < 2) {
              discussionInsights.push(cleaned.slice(0, 420));
            }
          }
        }
      }
    } catch (e) {}
  }

  return {
    metaDesc,
    bodyParagraphs,
    discussionInsights,
  };
}

function buildComprehensiveSummary(seed, details, aiGeneratedSummary = '') {
  const paragraphs = [];
  const isAiTopic = /\b(ai|llm|gpt|openai|gemini|anthropic|claude|neural|model|robot|gpu|nvidia|machine learning|deepmind|agent|transformer|inference)\b/i.test(
    seed.title
  );

  // Paragraph 1: AI Summary or Core Lead
  if (aiGeneratedSummary && aiGeneratedSummary.length >= 120) {
    paragraphs.push(aiGeneratedSummary.trim());
  } else if (details?.metaDesc && details.metaDesc.length >= 60) {
    paragraphs.push(
      `📌 Executive Briefing: ${details.metaDesc}${
        details.metaDesc.endsWith('.') ? '' : '.'
      } Reported by ${seed.sourceName}, "${seed.title}" examines key developments in ${
        isAiTopic
          ? 'artificial intelligence, foundation models, and modern AI infrastructure'
          : 'software engineering, systems architecture, and emerging technology'
      }.`
    );
  } else {
    paragraphs.push(
      `📌 Executive Briefing: "${seed.title}" — Published by ${seed.sourceName}, this report covers a notable development in ${
        isAiTopic
          ? 'artificial intelligence, machine learning models, and automated engineering workflows'
          : 'modern software systems, cloud infrastructure, and hardware engineering'
      }. The announcement has drawn active attention across the engineering community${
        seed.points ? ` (${seed.points} community points and ${seed.numComments || 0} technical comments)` : ''
      }.`
    );
  }

  // Paragraph 2 & 3: Extracted Article Body Paragraphs
  if (details?.bodyParagraphs && details.bodyParagraphs.length > 0) {
    const selectedParas = details.bodyParagraphs.slice(0, 3);
    selectedParas.forEach((p, idx) => {
      if (!paragraphs.some((existing) => existing.includes(p.slice(0, 45)))) {
        paragraphs.push(idx === 0 ? `🔍 Key Report Details: ${p}` : p);
      }
    });
  }

  // Paragraph 4: Technical / Community Context or Industry Impact
  if (details?.discussionInsights && details.discussionInsights.length > 0) {
    paragraphs.push(
      `💡 Technical Context & Analysis: ${details.discussionInsights.join(' — ')}`
    );
  } else if (paragraphs.join('\n\n').length < 650) {
    paragraphs.push(
      `🔍 Technical & Industry Breakdown: This report from ${seed.sourceName} focuses on the practical implications of "${seed.title}" for developers, researchers, and enterprise teams. Key areas of impact include ${
        isAiTopic
          ? 'model capability scaling, inference efficiency, developer tooling integration, and real-world deployment reliability across AI-driven systems'
          : 'system performance, security posture, developer productivity, and long-term platform maintainability across modern technology stacks'
      }.`
    );
    paragraphs.push(
      `💡 Why It Matters: As organizations rapidly iterate on ${
        isAiTopic ? 'generative AI and autonomous workflows' : 'next-generation software and hardware platforms'
      }, developments like this shape how engineering teams architect, evaluate, and deploy production systems. All essential highlights are summarized above so you can stay fully informed right here on Paper Flow, with the direct link to ${seed.sourceName} available below for reference.`
    );
  }

  return paragraphs.join('\n\n').slice(0, 2600);
}

async function fetchLiveTechArticlesSeed() {
  const candidates = [];
  const seenUrls = new Set();

  // Algolia treats multi-word queries as AND, so use focused single-topic search_by_date queries to gather 35+ latest stories
  const queries = [
    'https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&numericFilters=points>2&hitsPerPage=15',
    'https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story&numericFilters=points>1&hitsPerPage=12',
    'https://hn.algolia.com/api/v1/search_by_date?query=OpenAI&tags=story&numericFilters=points>1&hitsPerPage=10',
    'https://hn.algolia.com/api/v1/search_by_date?query=Gemini&tags=story&numericFilters=points>1&hitsPerPage=10',
    'https://hn.algolia.com/api/v1/search_by_date?query=Anthropic&tags=story&numericFilters=points>1&hitsPerPage=8',
    'https://hn.algolia.com/api/v1/search_by_date?query=GPU&tags=story&numericFilters=points>2&hitsPerPage=8',
    'https://hn.algolia.com/api/v1/search_by_date?query=Robotics&tags=story&numericFilters=points>1&hitsPerPage=8',
    'https://hn.algolia.com/api/v1/search_by_date?tags=front_page&hitsPerPage=18',
  ];

  await Promise.allSettled(
    queries.map(async (qUrl) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(qUrl, {
          headers: { 'User-Agent': 'PaperFlow-NewsBot/1.0' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.hits)) {
          for (const hit of data.hits) {
            const url = hit.url;
            const title = (hit.title || '').trim();
            if (!url || !title || seenUrls.has(url)) continue;
            seenUrls.add(url);
            const pubMs = hit.created_at_i
              ? hit.created_at_i * 1000
              : hit.created_at
              ? Date.parse(hit.created_at) || Date.now()
              : Date.now();
            candidates.push({
              objectID: hit.objectID || '',
              title,
              url,
              sourceName: extractDomainName(url),
              points: hit.points || 0,
              numComments: hit.num_comments || 0,
              storyText: hit.story_text ? stripHtmlTags(hit.story_text) : '',
              publishedAt: pubMs,
              createdAt: pubMs,
            });
          }
        }
      } catch (e) {
        // Ignore individual feed fetch failure
      }
    })
  );

  // Sort strictly by publication date (newest first)
  candidates.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return candidates.slice(0, 32);
}

function parseJsonArrayFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.articles)) return parsed.articles;
    if (parsed && Array.isArray(parsed.news)) return parsed.news;
  } catch (e) {
    const startIdx = cleaned.indexOf('[');
    const endIdx = cleaned.lastIndexOf(']');
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        const sub = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
        if (Array.isArray(sub)) return sub;
      } catch (innerErr) {}
    }
  }
  return null;
}

let inFlightNewsPromise = null;
let inFlightDeepEnrichPromise = null;

function mergeIntoAiTechNewsState(newItems, groundingSources = []) {
  if (!Array.isArray(newItems) || newItems.length === 0) return;
  const mergedMap = new Map();
  for (const item of [...newItems, ...aiTechNewsState.items]) {
    if (!item || !item.id) continue;
    const prev = mergedMap.get(item.id);
    if (!prev || (item.body && (!prev.body || item.body.length >= prev.body.length))) {
      mergedMap.set(item.id, item);
    }
  }
  aiTechNewsState.items = Array.from(mergedMap.values())
    .sort((a, b) => (b.publishedAt || b.createdAt || 0) - (a.publishedAt || a.createdAt || 0))
    .slice(0, 40);
  aiTechNewsState.lastUpdated = Date.now();
  if (groundingSources.length > 0) {
    aiTechNewsState.groundingSources = groundingSources.slice(0, 6);
  }
}

function enrichAiTechNewsInBackground(liveSeeds) {
  if (inFlightDeepEnrichPromise || !Array.isArray(liveSeeds) || liveSeeds.length === 0) {
    return;
  }

  inFlightDeepEnrichPromise = (async () => {
    try {
      const now = Date.now();
      const seedByUrl = new Map();
      liveSeeds.forEach((s) => {
        seedByUrl.set(String(s.url || '').trim().toLowerCase(), s);
      });

      const enrichedDetailsMap = new Map();
      await Promise.allSettled(
        liveSeeds.slice(0, 26).map(async (s) => {
          const details = await fetchArticleExcerptAndDiscussion(s);
          enrichedDetailsMap.set(s.url, details);
        })
      );

      // Immediately upgrade existing items with scraped article paragraphs & HN commentary
      const upgradedSeedItems = [];
      for (let i = 0; i < liveSeeds.length && upgradedSeedItems.length < 28; i++) {
        const s = liveSeeds[i];
        const isAiTopic = /\b(ai|llm|gpt|openai|gemini|anthropic|claude|neural|model|robot|gpu|nvidia|machine learning|deepmind|agent|transformer)\b/i.test(
          s.title
        );
        const pubMs = s.publishedAt || s.createdAt || now - i * 180000;
        const details = enrichedDetailsMap.get(s.url) || {};
        const comprehensiveBody = buildComprehensiveSummary(s, details);
        upgradedSeedItems.push({
          id: makeDeterministicNewsId(s.title, s.url),
          title: s.title.slice(0, 118),
          body: comprehensiveBody,
          tag: 'news',
          topic: isAiTopic ? 'AI & Machine Learning' : 'Technology',
          alias: 'Paper Flow AI News',
          authorUsername: 'ai_news_desk',
          isAiNews: true,
          summarizedByAi: true,
          aiAttribution: 'Summarized by AI',
          linkUrl: s.url,
          linkTitle: `${s.sourceName}: ${s.title}`.slice(0, 98),
          sourceName: s.sourceName,
          groundingSources: [],
          publishedAt: pubMs,
          createdAt: pubMs,
          ts: pubMs,
        });
      }
      mergeIntoAiTechNewsState(upgradedSeedItems);

      const ai = getAiClient();
      if (!ai) return;

      const seedContext =
        liveSeeds.length > 0
          ? `\nHere are verified live Tech & AI articles ordered from newest to oldest:\n` +
            liveSeeds
              .slice(0, 14)
              .map((s, i) => {
                const det = enrichedDetailsMap.get(s.url);
                const snippet = det?.metaDesc || det?.bodyParagraphs?.[0] || '';
                return `${i + 1}. "${s.title}" — Source: ${s.sourceName} — Published: ${new Date(
                  s.publishedAt
                ).toISOString()} — URL: ${s.url}${snippet ? ` — Excerpt: ${snippet.slice(0, 240)}` : ''}`;
              })
              .join('\n')
          : '';

      const prompt = `Summarize the following latest breaking Technology and Artificial Intelligence (AI) news stories, ordered from newest to oldest.
${seedContext}

Return ONLY a valid JSON array of up to 14 distinct Tech & AI news items sorted by newest date first.
IMPORTANT: Make each "summary" a comprehensive, detailed 3-paragraph briefing (800 to 1,500 characters) separated by "\\n\\n" so the reader gets the complete story, technical details, key numbers/features, and industry impact right on our website without needing to leave!
Each object in the JSON array MUST have these exact fields:
- "title": Clear, engaging headline (max 110 characters)
- "summary": Detailed 3-paragraph AI summary (800 to 1,500 characters)
- "sourceName": Publisher name
- "sourceUrl": Direct https:// URL to the original news source article
- "publishedAt": ISO 8601 timestamp string of the article's publication date/time
- "topic": Either "AI" or "Tech"

Output strictly the raw JSON array and nothing else.`;

      let response;
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
        });
      } catch (primaryErr) {
        response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
        });
      }

      const parsed = parseJsonArrayFromText(response?.text || '');
      if (Array.isArray(parsed) && parsed.length > 0) {
        const aiItems = parsed
          .map((item, idx) => {
            const title = String(item.title || '').trim();
            const rawSummary = String(item.summary || '').trim();
            if (!title || !rawSummary) return null;

            let sourceUrl = String(item.sourceUrl || item.url || '').trim();
            const matchingSeed = seedByUrl.get(sourceUrl.toLowerCase()) || liveSeeds[idx];
            if (!sourceUrl || !sourceUrl.startsWith('http')) {
              if (matchingSeed?.url) sourceUrl = matchingSeed.url;
            }
            if (!sourceUrl || !sourceUrl.startsWith('http')) return null;

            const exactSeed = seedByUrl.get(sourceUrl.toLowerCase());
            let pubMs = exactSeed?.publishedAt || 0;
            if (!pubMs && item.publishedAt) {
              const parsedDate = Date.parse(String(item.publishedAt));
              if (!Number.isNaN(parsedDate) && parsedDate > 0 && parsedDate <= Date.now() + 60000) {
                pubMs = parsedDate;
              }
            }
            if (!pubMs) {
              pubMs = matchingSeed?.publishedAt || Date.now() - idx * 180000;
            }

            const sourceName =
              String(item.sourceName || '').trim() || extractDomainName(sourceUrl);
            const topic = String(item.topic || 'AI').toUpperCase().includes('AI')
              ? 'AI & Machine Learning'
              : 'Technology';
            const details = enrichedDetailsMap.get(sourceUrl) || {};
            const fullSummary =
              rawSummary.length >= 600
                ? rawSummary.slice(0, 2600)
                : buildComprehensiveSummary(
                    exactSeed || { title, url: sourceUrl, sourceName },
                    details,
                    rawSummary
                  );

            return {
              id: makeDeterministicNewsId(title, sourceUrl),
              title: title.slice(0, 118),
              body: fullSummary,
              tag: 'news',
              topic,
              alias: 'Paper Flow AI News',
              authorUsername: 'ai_news_desk',
              isAiNews: true,
              summarizedByAi: true,
              aiAttribution: 'Summarized by AI',
              linkUrl: sourceUrl,
              linkTitle: `${sourceName}: ${title}`.slice(0, 98),
              sourceName,
              groundingSources: [],
              publishedAt: pubMs,
              createdAt: pubMs,
              ts: pubMs,
            };
          })
          .filter(Boolean);

        mergeIntoAiTechNewsState(aiItems);
      }
    } catch (e) {
      // Background enrichment is best-effort
    } finally {
      inFlightDeepEnrichPromise = null;
    }
  })();
}

async function refreshAiTechNews(force = false) {
  const now = Date.now();
  if (
    !force &&
    aiTechNewsState.items.length >= 20 &&
    now - aiTechNewsState.lastUpdated < NEWS_REFRESH_INTERVAL_MS
  ) {
    return aiTechNewsState;
  }
  if (inFlightNewsPromise) {
    return inFlightNewsPromise;
  }

  aiTechNewsState.isRefreshing = true;

  inFlightNewsPromise = (async () => {
    try {
      const liveSeeds = await fetchLiveTechArticlesSeed();
      if (liveSeeds.length > 0) {
        const fastItems = [];
        for (let i = 0; i < liveSeeds.length && fastItems.length < 28; i++) {
          const s = liveSeeds[i];
          const isAiTopic = /\b(ai|llm|gpt|openai|gemini|anthropic|claude|neural|model|robot|gpu|nvidia|machine learning|deepmind|agent|transformer)\b/i.test(
            s.title
          );
          const pubMs = s.publishedAt || s.createdAt || now - i * 180000;
          const comprehensiveBody = buildComprehensiveSummary(s, {});

          fastItems.push({
            id: makeDeterministicNewsId(s.title, s.url),
            title: s.title.slice(0, 118),
            body: comprehensiveBody,
            tag: 'news',
            topic: isAiTopic ? 'AI & Machine Learning' : 'Technology',
            alias: 'Paper Flow AI News',
            authorUsername: 'ai_news_desk',
            isAiNews: true,
            summarizedByAi: true,
            aiAttribution: 'Summarized by AI',
            linkUrl: s.url,
            linkTitle: `${s.sourceName}: ${s.title}`.slice(0, 98),
            sourceName: s.sourceName,
            groundingSources: [],
            publishedAt: pubMs,
            createdAt: pubMs,
            ts: pubMs,
          });
        }

        mergeIntoAiTechNewsState(fastItems);
        // Trigger deep paragraph & Gemini enrichment asynchronously without blocking the response
        enrichAiTechNewsInBackground(liveSeeds);
      }
    } catch (err) {
      console.error('AI Tech News refresh error:', err?.message || err);
    } finally {
      aiTechNewsState.isRefreshing = false;
      inFlightNewsPromise = null;
    }

    return aiTechNewsState;
  })();

  return inFlightNewsPromise;
}

// Kick off initial news fetch and schedule regular 15-minute updates
refreshAiTechNews(true).catch(() => {});
setInterval(() => {
  refreshAiTechNews(true).catch(() => {});
}, NEWS_REFRESH_INTERVAL_MS);

app.get('/api/ai-tech-news', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const state = await refreshAiTechNews(force);
    res.json({
      ok: true,
      updatedAt: state.lastUpdated,
      lastUpdated: state.lastUpdated,
      refreshIntervalMinutes: 15,
      items: state.items,
      groundingSources: state.groundingSources,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to fetch AI Tech News',
      items: aiTechNewsState.items || [],
    });
  }
});

app.post('/api/ai-tech-news/refresh', async (req, res) => {
  try {
    const state = await refreshAiTechNews(true);
    res.json({
      ok: true,
      lastUpdated: state.lastUpdated,
      items: state.items,
      groundingSources: state.groundingSources,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to refresh AI Tech News',
      items: aiTechNewsState.items || [],
    });
  }
});

app.get('/robots.txt', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const lastMod = new Date().toISOString().split('T')[0];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

function serveApkFile(req, res) {
  const rootApk = path.join(__dirname, 'Paper-Flow.apk');
  const publicApk = path.join(__dirname, 'public', 'Paper-Flow.apk');
  const targetApk = fs.existsSync(rootApk) ? rootApk : publicApk;

  if (!fs.existsSync(targetApk)) {
    res.status(404).type('text/plain').send('APK not found');
    return;
  }

  res.sendFile(targetApk, {
    acceptRanges: true,
    etag: true,
    lastModified: true,
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="Paper-Flow.apk"',
      'Cache-Control': 'public, max-age=60, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

app.get('/Paper-Flow.apk', serveApkFile);
app.get('/public/Paper-Flow.apk', serveApkFile);
app.get('/download/Paper-Flow.apk', serveApkFile);
app.get('/api/download-apk', serveApkFile);

app.get('/api/app-version', (req, res) => {
  res.json({
    latestVersionCode: 3,
    latestVersionName: '1.0.3',
    tag: 'Updated',
    apkUrl: '/download/Paper-Flow.apk?v=1.0.3',
    title: 'Paper Flow v1.0.3 (Updated)',
    releaseNotes: 'Updated with AI-summarized Tech & AI News column, floating Siri-glow circular refresh button, iPhone Siri orange glass Dark Mode transition, centered + bottom dock, and scrollable Paper Messages.'
  });
});

// ── WEB PUSH & CONSTANT BACKGROUND NOTIFICATIONS ENGINE ────────────────────────
const VAPID_PUBLIC_KEY = 'BGFFQRyPCHVbwWABejyqdpiOovIMThEHa4D10b6fkxFULQFxwZcE_ko98W7jLlC0-au1hLtRS9R6Yw5XZps1eSA';
const VAPID_PRIVATE_KEY = 'lasHOuS2mq23bYgw87rfMFbaYxK3ftRKza86tC5EUQE';

webpush.setVapidDetails(
  'mailto:arnavsri210@gmail.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const PUSH_SUBS_FILE = path.join(__dirname, 'push_subscriptions.json');
let pushSubscriptions = [];

function loadPushSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {}
  return [];
}

function savePushSubscriptions() {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2), 'utf-8');
  } catch (e) {}
}

pushSubscriptions = loadPushSubscriptions();

app.get('/api/push-vapid-public-key', (req, res) => {
  res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push-subscribe', (req, res) => {
  const { subscription, usernameLower } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    res.status(400).json({ ok: false, error: 'Invalid subscription' });
    return;
  }
  const endpoint = subscription.endpoint;
  const existingIdx = pushSubscriptions.findIndex(s => s.subscription?.endpoint === endpoint);
  const entry = {
    subscription,
    usernameLower: usernameLower ? String(usernameLower).trim().toLowerCase() : 'guest',
    updatedAt: Date.now()
  };
  if (existingIdx >= 0) {
    pushSubscriptions[existingIdx] = entry;
  } else {
    pushSubscriptions.push(entry);
  }
  savePushSubscriptions();
  res.json({ ok: true, count: pushSubscriptions.length });
});

app.post('/api/push-unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) {
    pushSubscriptions = pushSubscriptions.filter(s => s.subscription?.endpoint !== endpoint);
    savePushSubscriptions();
  }
  res.json({ ok: true });
});

async function sendPushToSubscribers(payload, filterFn) {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const targets = filterFn ? pushSubscriptions.filter(filterFn) : pushSubscriptions;
  const deadEndpoints = new Set();

  await Promise.allSettled(
    targets.map(async (entry) => {
      try {
        await webpush.sendNotification(entry.subscription, payloadStr, {
          TTL: 60 * 60 * 24 // 24 hours
        });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deadEndpoints.add(entry.subscription.endpoint);
        }
      }
    })
  );

  if (deadEndpoints.size > 0) {
    pushSubscriptions = pushSubscriptions.filter(s => !deadEndpoints.has(s.subscription?.endpoint));
    savePushSubscriptions();
  }
}

// Endpoint to broadcast a developer flow alert to all subscribers
app.post('/api/push-notify-developer-flow', async (req, res) => {
  const { postId, title, body, author } = req.body || {};
  const notifPayload = {
    title: `⚡ Developer Update: ${title || 'New Developer Flow'}`,
    body: (body || 'The developer shared a new update on Paper Flow. Tap to read and reply.').slice(0, 140),
    postId: postId || '',
    url: `/?post=${encodeURIComponent(postId || '')}`,
    tag: `dev_${postId || Date.now()}`
  };
  sendPushToSubscribers(notifPayload).catch(() => {});
  res.json({ ok: true, sentTo: pushSubscriptions.length });
});

// Endpoint to notify post author when someone replies
app.post('/api/push-notify-reply', async (req, res) => {
  const { postId, targetUsername, flowTitle, replier, text } = req.body || {};
  if (!targetUsername) {
    res.json({ ok: false, error: 'targetUsername required' });
    return;
  }
  const cleanTarget = String(targetUsername).trim().toLowerCase();
  const notifPayload = {
    title: `@${replier || 'Someone'} replied to "${(flowTitle || 'your flow').slice(0, 36)}"`,
    body: (text || 'New reply on your flow').slice(0, 140),
    postId: postId || '',
    url: `/?post=${encodeURIComponent(postId || '')}`,
    tag: `reply_${postId}_${Date.now()}`
  };
  sendPushToSubscribers(notifPayload, (entry) => entry.usernameLower === cleanTarget).catch(() => {});
  res.json({ ok: true });
});

// Cache of latest developer flows for background sync and polling
let cachedDeveloperFlows = [];
let seenDevPostIds = new Set();
let isCheckingFirestoreDevPosts = false;

async function checkFirestoreForNewDeveloperFlows() {
  if (isCheckingFirestoreDevPosts) return;
  isCheckingFirestoreDevPosts = true;
  try {
    const url = 'https://firestore.googleapis.com/v1/projects/memo-board-4d45b/databases/(default)/documents/posts?pageSize=30';
    const resp = await fetch(url);
    if (!resp.ok) return;
    const json = await resp.json();
    if (!json.documents || !Array.isArray(json.documents)) return;

    const devFlows = [];
    json.documents.forEach((doc) => {
      const fields = doc.fields || {};
      const id = doc.name ? doc.name.split('/').pop() : '';
      if (!id || id.startsWith('__')) return;

      const authorUsername = fields.authorUsername?.stringValue || '';
      const alias = fields.alias?.stringValue || '';
      const isDev = authorUsername.toLowerCase() === 'marvelist' || alias.toLowerCase() === 'marvelist';
      if (!isDev) return;

      const title = fields.title?.stringValue || null;
      const body = fields.body?.stringValue || '';
      const ts = fields.ts?.timestampValue ? new Date(fields.ts.timestampValue).getTime() : Date.now();

      devFlows.push({ id, title, body, authorUsername, alias, ts });

      // If this is a newly discovered developer post, push notification to all subscribers!
      if (!seenDevPostIds.has(id)) {
        seenDevPostIds.add(id);
        if (seenDevPostIds.size > 1) { // Avoid blasting on initial server boot
          const notifPayload = {
            title: `⚡ Developer Update: ${title || 'New Flow from Developer'}`,
            body: (body || 'The developer shared a new update on Paper Flow. Tap to read.').slice(0, 140),
            postId: id,
            url: `/?post=${encodeURIComponent(id)}`,
            tag: `dev_${id}`
          };
          sendPushToSubscribers(notifPayload).catch(() => {});
        }
      }
    });

    devFlows.sort((a, b) => b.ts - a.ts);
    cachedDeveloperFlows = devFlows;
  } catch (e) {
    // Graceful error ignore
  } finally {
    isCheckingFirestoreDevPosts = false;
  }
}

// Background poll Firestore every 45 seconds to keep notifications constant even if no one is visiting
checkFirestoreForNewDeveloperFlows().catch(() => {});
setInterval(() => {
  checkFirestoreForNewDeveloperFlows().catch(() => {});
}, 45 * 1000);

app.get('/api/developer-flows/latest', (req, res) => {
  res.json({
    ok: true,
    items: cachedDeveloperFlows
  });
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

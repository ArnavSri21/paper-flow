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

function cleanRoboticPrefixes(text) {
  if (!text) return '';
  return String(text)
    .replace(/^(?:📌\s*)?(?:Executive Briefing|Key Overview|Overview|Summary|TL;DR)\s*:\s*/gim, '')
    .replace(/^(?:🔍\s*)?(?:Key Report Details|Technical & Industry Breakdown|Technical & Industry Details|Key Details)\s*:\s*/gim, '')
    .replace(/^(?:💡\s*)?(?:Technical Context & Analysis|Why It Matters|Industry Impact|Takeaway)\s*:\s*/gim, '')
    .trim();
}

function isInterestingTechStory(title, url = '', points = 0, numComments = 0) {
  const t = String(title || '').trim();
  if (!t || t.length < 18) return false;
  // Filter out uninteresting / administrative / meta / hiring / low-signal posts
  if (/^(ask hn|tell hn|poll:|who is hiring|who wants to be hired|freelancer\?|show hn:\s*my first|my simple|test post)/i.test(t)) {
    return false;
  }
  if (/\b(hiring|job opening|career thread|daily thread|open thread|sponsored|press release|webinar|discount code|coupon|changelog v0\.0|minor bugfix| bump version)\b/i.test(t)) {
    return false;
  }
  const techSignalRegex = /\b(ai|llm|gpt|openai|gemini|anthropic|claude|deepmind|mistral|deepseek|qwen|llama|nvidia|amd|intel|gpu|tpu|npu|robotics|robot|humanoid|quantum|fusion|neural|transformer|agent|agentic|open-source|open source|apple|google|microsoft|meta|tesla|spacex|linux|rust|python|typescript|javascript|golang|kernel|browser|chrome|firefox|webkit|chip|semiconductor|tsmc|cybersecurity|security|zero-day|vulnerability|encryption|database|postgres|sqlite|compiler|cloud|kubernetes|docker|wasm|webgpu|api|sdk|github|git|algorithm|model|inference|benchmark|autonomous|waymo|biotech|crispr|alphafold|protein|space|satellite|nasa|cern|physics|battery|silicon|hardware|software|developer|engineering|programming|code|coding|server|network|protocol)\b/i;
  const isTechDomain = /\b(github\.com|arxiv\.org|huggingface\.co|openai\.com|anthropic\.com|deepmind\.google|blog\.google|apple\.com|microsoft\.com|nvidia\.com|techcrunch\.com|arstechnica\.com|theverge\.com|wired\.com|ieee\.org|nature\.com|mit\.edu|stanford\.edu|cloudflare\.com|tailscale\.com|mozilla\.org|kernel\.org|rust-lang\.org)\b/i.test(url);
  if (!techSignalRegex.test(t) && !isTechDomain) {
    return false;
  }
  if (points >= 20 || numComments >= 8) return true;
  return false;
}

function computeStoryInterestScore(seed) {
  const pts = Number(seed.points || 0);
  const cmts = Number(seed.numComments || 0);
  const t = String(seed.title || '');
  let bonus = 0;
  if (/\b(breakthrough|open-source|launch|introducing|announcing|released|benchmark|reasoning|agent|robotics|quantum|chip|architecture|paper|discover|mit|stanford|deepmind|openai|anthropic|gemini|nvidia)\b/i.test(t)) {
    bonus += 45;
  }
  if (/^(show hn)/i.test(t) && pts < 50) {
    bonus -= 20;
  }
  const ageHours = Math.max(1, (Date.now() - (seed.publishedAt || Date.now())) / 3600000);
  const recencyBoost = Math.max(0, 48 - ageHours) * 1.5;
  return pts * 1.4 + cmts * 1.8 + bonus + recencyBoost;
}

function detectStoryTopicTags(title, body = '') {
  const combined = `${title || ''} ${body || ''}`.toLowerCase();
  const tags = [];
  const rules = [
    ['LLMs & Foundation Models', /\b(llm|gpt|claude|gemini|llama|mistral|deepseek|qwen|openai|anthropic|foundation model|reasoning model|o1|o3)\b/i],
    ['AI Agents & Coding', /\b(agent|agentic|coding|copilot|cursor|codegen|autonomy|workflow|tool use|mcp|developer tool|ide)\b/i],
    ['GPUs, Chips & Hardware', /\b(gpu|nvidia|amd|intel|tpu|tsmc|chip|semiconductor|silicon|npu|cuda|hardware|inference chip)\b/i],
    ['Robotics & Embodied AI', /\b(robot|robotics|humanoid|autonomous|drone|self-driving|waymo|figure|boston dynamics|sensor)\b/i],
    ['Open Source & Research', /\b(open source|open-source|arxiv|paper|huggingface|weights|benchmark|mit|stanford|research|dataset)\b/i],
    ['Systems, Cloud & Security', /\b(linux|rust|kernel|database|postgres|cloud|kubernetes|security|encryption|privacy|zero-day|browser|distributed)\b/i],
    ['Science & Deep Tech', /\b(quantum|fusion|biotech|protein|alphafold|space|spacex|physics|materials|neuroscience|energy)\b/i],
  ];
  for (const [label, regex] of rules) {
    if (regex.test(combined)) tags.push(label);
  }
  if (tags.length === 0) tags.push('Emerging Tech');
  return tags;
}

function buildComprehensiveSummary(seed, details, aiGeneratedSummary = '') {
  if (aiGeneratedSummary && aiGeneratedSummary.length >= 160) {
    return cleanRoboticPrefixes(aiGeneratedSummary).slice(0, 2600);
  }

  const paragraphs = [];
  const cleanMeta = details?.metaDesc ? cleanRoboticPrefixes(details.metaDesc) : '';
  const bodyParas = Array.isArray(details?.bodyParagraphs)
    ? details.bodyParagraphs.map(cleanRoboticPrefixes).filter(Boolean)
    : [];
  const insights = Array.isArray(details?.discussionInsights)
    ? details.discussionInsights.map(cleanRoboticPrefixes).filter(Boolean)
    : [];

  // Paragraph 1: Natural, engaging journalistic hook
  if (cleanMeta && cleanMeta.length >= 55) {
    const hookSentence = cleanMeta.endsWith('.') || cleanMeta.endsWith('!') || cleanMeta.endsWith('?')
      ? cleanMeta
      : `${cleanMeta}.`;
    if (bodyParas.length > 0 && !bodyParas[0].includes(cleanMeta.slice(0, 35))) {
      paragraphs.push(hookSentence);
    } else {
      paragraphs.push(
        `${hookSentence} The story, first highlighted via ${seed.sourceName}, has quickly sparked discussion among engineers and researchers tracking ${detectStoryTopicTags(seed.title, cleanMeta)[0].toLowerCase()}.`
      );
    }
  } else if (bodyParas.length > 0) {
    paragraphs.push(bodyParas[0]);
  } else {
    const topicLabel = detectStoryTopicTags(seed.title)[0];
    paragraphs.push(
      `${seed.sourceName} is out with a notable look at "${seed.title}", a development drawing strong interest across the ${topicLabel.toLowerCase()} community${
        seed.points ? ` with over ${seed.points} upvotes and ${seed.numComments || 0} comments in technical discussions` : ''
      }.`
    );
  }

  // Paragraph 2 & 3: Real extracted story paragraphs
  const startIdx = !cleanMeta && bodyParas.length > 0 ? 1 : 0;
  for (let i = startIdx; i < bodyParas.length && paragraphs.length < 3; i++) {
    const p = bodyParas[i];
    if (p && !paragraphs.some((existing) => existing.includes(p.slice(0, 45)))) {
      paragraphs.push(p);
    }
  }

  // Paragraph 4: Community & practitioner perspective (if available)
  if (insights.length > 0) {
    paragraphs.push(
      `In community discussions around the release, engineers noted: "${insights[0]}"${
        insights[1] ? ` Another practitioner added: "${insights[1]}"` : ''
      }`
    );
  } else if (paragraphs.join('\n\n').length < 420) {
    const tags = detectStoryTopicTags(seed.title, cleanMeta);
    paragraphs.push(
      `What makes this worth watching is how directly it intersects with ${tags.join(' and ').toLowerCase()}. Engineers evaluating "${seed.title}" are focusing on real-world benchmarks, deployment trade-offs, and how teams can integrate the findings into production workflows.`
    );
  }

  return paragraphs.join('\n\n').slice(0, 2600);
}

async function fetchLiveTechArticlesSeed() {
  const candidates = [];
  const seenUrls = new Set();

  // High-signal queries with stronger point thresholds so only genuinely interesting stories surface
  const queries = [
    'https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&numericFilters=points>25&hitsPerPage=18',
    'https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story&numericFilters=points>20&hitsPerPage=14',
    'https://hn.algolia.com/api/v1/search_by_date?query=OpenAI&tags=story&numericFilters=points>25&hitsPerPage=12',
    'https://hn.algolia.com/api/v1/search_by_date?query=Gemini&tags=story&numericFilters=points>15&hitsPerPage=12',
    'https://hn.algolia.com/api/v1/search_by_date?query=Anthropic&tags=story&numericFilters=points>20&hitsPerPage=12',
    'https://hn.algolia.com/api/v1/search_by_date?query=GPU&tags=story&numericFilters=points>25&hitsPerPage=10',
    'https://hn.algolia.com/api/v1/search_by_date?query=Robotics&tags=story&numericFilters=points>15&hitsPerPage=10',
    'https://hn.algolia.com/api/v1/search?tags=front_page&numericFilters=points>45&hitsPerPage=24',
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
            const points = Number(hit.points || 0);
            const numComments = Number(hit.num_comments || 0);
            if (!isInterestingTechStory(title, url, points, numComments)) continue;
            seenUrls.add(url);
            const pubMs = hit.created_at_i
              ? hit.created_at_i * 1000
              : hit.created_at
              ? Date.parse(hit.created_at) || Date.now()
              : Date.now();
            const seedObj = {
              objectID: hit.objectID || '',
              title,
              url,
              sourceName: extractDomainName(url),
              points,
              numComments,
              storyText: hit.story_text ? stripHtmlTags(hit.story_text) : '',
              publishedAt: pubMs,
              createdAt: pubMs,
            };
            seedObj.interestScore = computeStoryInterestScore(seedObj);
            seedObj.topicTags = detectStoryTopicTags(title, seedObj.storyText);
            candidates.push(seedObj);
          }
        }
      } catch (e) {
        // Ignore individual feed fetch failure
      }
    })
  );

  // Filter to top most interesting stories first, then sort by publication date (newest first)
  candidates.sort((a, b) => (b.interestScore || 0) - (a.interestScore || 0));
  const curatedTop = candidates.slice(0, 26);
  curatedTop.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return curatedTop;
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
    const cleanedBody = cleanRoboticPrefixes(item.body || '');
    const normalizedItem = {
      ...item,
      body: cleanedBody,
      topicTags: Array.isArray(item.topicTags) && item.topicTags.length > 0
        ? item.topicTags
        : detectStoryTopicTags(item.title, cleanedBody),
    };
    const prev = mergedMap.get(item.id);
    if (!prev || (cleanedBody && (!prev.body || cleanedBody.length >= prev.body.length))) {
      mergedMap.set(item.id, normalizedItem);
    }
  }
  aiTechNewsState.items = Array.from(mergedMap.values())
    .sort((a, b) => (b.publishedAt || b.createdAt || 0) - (a.publishedAt || a.createdAt || 0))
    .slice(0, 32);
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
        liveSeeds.slice(0, 24).map(async (s) => {
          const details = await fetchArticleExcerptAndDiscussion(s);
          enrichedDetailsMap.set(s.url, details);
        })
      );

      // Immediately upgrade existing items with scraped article paragraphs & HN commentary
      const upgradedSeedItems = [];
      for (let i = 0; i < liveSeeds.length && upgradedSeedItems.length < 24; i++) {
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
          topicTags: s.topicTags || detectStoryTopicTags(s.title, comprehensiveBody),
          interestScore: s.interestScore || 50,
          points: s.points || 0,
          numComments: s.numComments || 0,
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
          ? `\nHere are candidate live Tech & AI articles:\n` +
            liveSeeds
              .slice(0, 16)
              .map((s, i) => {
                const det = enrichedDetailsMap.get(s.url);
                const snippet = det?.metaDesc || det?.bodyParagraphs?.[0] || '';
                const insight = det?.discussionInsights?.[0] || '';
                return `${i + 1}. "${s.title}" — Source: ${s.sourceName} (${s.points || 0} pts, ${s.numComments || 0} comments) — Published: ${new Date(
                  s.publishedAt
                ).toISOString()} — URL: ${s.url}${snippet ? ` — Lead: ${snippet.slice(0, 260)}` : ''}${insight ? ` — Engineer Take: ${insight.slice(0, 180)}` : ''}`;
              })
              .join('\n')
          : '';

      const prompt = `You are a sharp, engaging technology editor writing for curious engineers and builders.
Review the candidate Tech & AI stories below and FILTER OUT any boring, routine, or low-substance items. Select ONLY the most genuinely fascinating, high-impact stories (up to 12 stories).
${seedContext}

WRITING STYLE RULES (CRITICAL):
1. Write in natural, vivid, human journalistic prose — like The Verge, Ars Technica, or MIT Tech Review.
2. NEVER use emoji headers or robotic labels like "📌 Executive Briefing:", "🔍 Technical & Industry Breakdown:", "💡 Why It Matters:", or "Key Overview:".
3. Separate each summary into 3 natural paragraphs using "\\n\\n":
   - Paragraph 1 (The Hook — 2 to 3 crisp sentences): Immediately tell the reader what just happened and why it's fascinating or surprising. This first paragraph is shown before "Read more", so make it genuinely compelling!
   - Paragraph 2 (How It Works & Key Details): Concrete technical details, numbers, architecture, or what actually changed under the hood.
   - Paragraph 3 (The Bigger Picture): Real-world implications, caveats raised by engineers, and what to watch next.

Return ONLY a valid JSON array where each object has:
- "title": Punchy, natural headline (max 110 chars)
- "summary": 3-paragraph natural journalistic story separated by "\\n\\n" (650 to 1,400 chars)
- "sourceName": Publisher name
- "sourceUrl": Direct https:// URL from the candidate list
- "publishedAt": ISO 8601 timestamp string
- "topic": Either "AI" or "Tech"
- "topicTags": Array of 1 to 2 specific topic labels (e.g. ["LLMs & Foundation Models", "Open Source & Research"])

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
            const rawSummary = cleanRoboticPrefixes(String(item.summary || '').trim());
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
              rawSummary.length >= 420
                ? rawSummary.slice(0, 2600)
                : buildComprehensiveSummary(
                    exactSeed || { title, url: sourceUrl, sourceName },
                    details,
                    rawSummary
                  );

            return {
              id: makeDeterministicNewsId(exactSeed?.title || title, sourceUrl),
              title: title.slice(0, 118),
              body: fullSummary,
              tag: 'news',
              topic,
              topicTags: Array.isArray(item.topicTags) && item.topicTags.length > 0
                ? item.topicTags
                : detectStoryTopicTags(title, fullSummary),
              interestScore: (exactSeed?.interestScore || 60) + 25,
              points: exactSeed?.points || 0,
              numComments: exactSeed?.numComments || 0,
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
    aiTechNewsState.items.length >= 16 &&
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
        for (let i = 0; i < liveSeeds.length && fastItems.length < 24; i++) {
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
            topicTags: s.topicTags || detectStoryTopicTags(s.title, comprehensiveBody),
            interestScore: s.interestScore || 50,
            points: s.points || 0,
            numComments: s.numComments || 0,
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

// ── PER-USER DATABASE & AI NEWS PERSONALIZATION ENGINE ───────────────────────
const USER_PROFILES_FILE = path.join(__dirname, 'user_news_profiles.json');
let userNewsProfilesDb = {};

function loadUserNewsProfilesDb() {
  try {
    if (fs.existsSync(USER_PROFILES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USER_PROFILES_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {}
  return {};
}

function saveUserNewsProfilesDb() {
  try {
    fs.writeFileSync(USER_PROFILES_FILE, JSON.stringify(userNewsProfilesDb, null, 2), 'utf-8');
  } catch (e) {}
}

userNewsProfilesDb = loadUserNewsProfilesDb();

function buildHeuristicUserTasteProfile(interactions = []) {
  const topicCounts = {};
  const keywordCounts = {};
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have', 'more', 'about',
    'what', 'when', 'where', 'which', 'their', 'there', 'been', 'were', 'will', 'would', 'could',
    'should', 'after', 'before', 'over', 'under', 'using', 'first', 'new', 'how', 'why', 'its',
    'are', 'was', 'not', 'but', 'you', 'all', 'can', 'has', 'just', 'like', 'now', 'out', 'who'
  ]);

  interactions.forEach((entry) => {
    const weight = entry.action === 'star' ? 4 : entry.action === 'like' ? 3 : 1.5;
    const title = String(entry.title || '');
    const body = String(entry.body || '');
    const tags = Array.isArray(entry.topicTags) && entry.topicTags.length > 0
      ? entry.topicTags
      : detectStoryTopicTags(title, body);

    tags.forEach((t) => {
      topicCounts[t] = (topicCounts[t] || 0) + weight;
    });

    const words = `${title} ${entry.sourceName || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !stopWords.has(w));
    words.forEach((w) => {
      keywordCounts[w] = (keywordCounts[w] || 0) + weight;
    });
  });

  const topTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  const preferredKeywords = Object.entries(keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([kw]) => kw);

  const personaSummary = topTopics.length > 0
    ? `Curated for your interest in ${topTopics.slice(0, 2).join(' & ')}${preferredKeywords.length > 0 ? ` (${preferredKeywords.slice(0, 4).join(', ')})` : ''}.`
    : 'Personalized as you star, like, and read Tech & AI stories.';

  return {
    topTopics,
    preferredKeywords,
    topicWeights: topicCounts,
    personaSummary,
    updatedAt: Date.now(),
  };
}

function scoreNewsItemForUserProfile(item, profile) {
  if (!profile || (!profile.topTopics?.length && !profile.preferredKeywords?.length)) {
    return { relevanceScore: 0, matchReason: null };
  }
  let score = 0;
  let matchedTopic = null;
  const itemTags = Array.isArray(item.topicTags) && item.topicTags.length > 0
    ? item.topicTags
    : detectStoryTopicTags(item.title, item.body);

  for (const tag of itemTags) {
    const w = profile.topicWeights?.[tag] || (profile.topTopics?.includes(tag) ? 4 : 0);
    if (w > 0) {
      score += w * 12;
      if (!matchedTopic) matchedTopic = tag;
    }
  }

  const hay = `${item.title || ''} ${item.body || ''} ${item.sourceName || ''}`.toLowerCase();
  const matchedKeywords = [];
  for (const kw of profile.preferredKeywords || []) {
    if (kw && kw.length >= 3 && hay.includes(kw.toLowerCase())) {
      score += 18;
      if (matchedKeywords.length < 2) matchedKeywords.push(kw);
    }
  }

  let matchReason = null;
  if (matchedTopic && matchedKeywords.length > 0) {
    matchReason = `Matches your interest in ${matchedTopic} (${matchedKeywords.join(', ')})`;
  } else if (matchedTopic) {
    matchReason = `Matches your interest in ${matchedTopic}`;
  } else if (matchedKeywords.length > 0) {
    matchReason = `Picked for you: ${matchedKeywords.join(', ')}`;
  }

  return { relevanceScore: score, matchReason };
}

app.get('/api/user-news-profile/:userKey', (req, res) => {
  const userKey = String(req.params.userKey || '').trim().toLowerCase();
  const profile = userNewsProfilesDb[userKey] || null;
  res.json({ ok: true, userKey, profile });
});

app.post('/api/user-news-profile/analyze', async (req, res) => {
  try {
    const { userKey, username, interactions } = req.body || {};
    const cleanKey = String(userKey || username || 'guest').trim().toLowerCase();
    const list = Array.isArray(interactions) ? interactions.slice(-45) : [];

    const baseProfile = buildHeuristicUserTasteProfile(list);
    let aiProfile = { ...baseProfile, userKey: cleanKey, interactionCount: list.length };

    const ai = getAiClient();
    if (ai && list.length >= 1) {
      try {
        const historyLines = list
          .slice(-20)
          .map((it, idx) => `${idx + 1}. [${String(it.action || 'read').toUpperCase()}] "${it.title || ''}" (${(it.topicTags || []).join(', ')})`)
          .join('\n');

        const prompt = `Analyze this user's reading, liking, and starring history on Paper Flow Tech & AI News:
${historyLines}

Return ONLY a valid JSON object with:
- "personaSummary": A concise 1-sentence natural summary of what tech/AI topics this user loves (max 110 chars, e.g. "Tailored for your interest in open-source LLMs, AI coding agents, and GPU architecture.")
- "topTopics": Array of 2 to 3 topic categories from ["LLMs & Foundation Models", "AI Agents & Coding", "GPUs, Chips & Hardware", "Robotics & Embodied AI", "Open Source & Research", "Systems, Cloud & Security", "Science & Deep Tech"]
- "preferredKeywords": Array of 5 to 8 lowercase technical keywords this user gravitates toward

Output strictly raw JSON.`;

        let aiRes;
        try {
          aiRes = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
          });
        } catch (err1) {
          aiRes = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
          });
        }

        const rawJson = String(aiRes?.text || '')
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        const parsed = JSON.parse(rawJson);
        if (parsed && typeof parsed === 'object') {
          if (parsed.personaSummary) aiProfile.personaSummary = String(parsed.personaSummary).slice(0, 140);
          if (Array.isArray(parsed.topTopics) && parsed.topTopics.length > 0) {
            aiProfile.topTopics = parsed.topTopics.slice(0, 3).map(String);
            aiProfile.topTopics.forEach((t, i) => {
              aiProfile.topicWeights[t] = (aiProfile.topicWeights[t] || 0) + (10 - i * 2);
            });
          }
          if (Array.isArray(parsed.preferredKeywords) && parsed.preferredKeywords.length > 0) {
            aiProfile.preferredKeywords = Array.from(
              new Set([...parsed.preferredKeywords.map((k) => String(k).toLowerCase()), ...baseProfile.preferredKeywords])
            ).slice(0, 12);
          }
        }
      } catch (aiErr) {
        // Fallback to heuristic profile seamlessly
      }
    }

    userNewsProfilesDb[cleanKey] = aiProfile;
    saveUserNewsProfilesDb();

    res.json({
      ok: true,
      userKey: cleanKey,
      profile: aiProfile,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not analyze user news profile' });
  }
});

// ── FLOW SNAPSHOT IMAGE HOSTING FOR NATIVE & WEB SHARE ───────────────────────
const sharedSnapshotsCache = new Map();

app.post('/api/share-snapshot', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { postId, dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      res.status(400).json({ ok: false, error: 'Invalid PNG dataUrl' });
      return;
    }
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    const snapId = `${String(postId || 'flow').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}_${Date.now().toString(36)}`;
    sharedSnapshotsCache.set(snapId, { buffer: buf, createdAt: Date.now() });
    if (sharedSnapshotsCache.size > 80) {
      const oldestKey = sharedSnapshotsCache.keys().next().value;
      if (oldestKey) sharedSnapshotsCache.delete(oldestKey);
    }
    const baseUrl = getBaseUrl(req);
    res.json({
      ok: true,
      snapshotId: snapId,
      snapshotUrl: `${baseUrl}/api/share-snapshot/${snapId}.png`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to store snapshot' });
  }
});

app.get('/api/share-snapshot/:snapFile', (req, res) => {
  const snapId = String(req.params.snapFile || '').replace(/\.png$/i, '');
  const entry = sharedSnapshotsCache.get(snapId);
  if (!entry || !entry.buffer) {
    res.status(404).send('Snapshot not found');
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(entry.buffer);
});

app.get('/api/ai-tech-news', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const userKey = String(req.query.user || '').trim().toLowerCase();
    const state = await refreshAiTechNews(force);
    const profile = userKey ? userNewsProfilesDb[userKey] : null;

    const items = (state.items || []).map((it) => {
      const cleaned = {
        ...it,
        body: cleanRoboticPrefixes(it.body || ''),
      };
      if (profile) {
        const { relevanceScore, matchReason } = scoreNewsItemForUserProfile(cleaned, profile);
        return { ...cleaned, relevanceScore, matchReason };
      }
      return cleaned;
    });

    res.json({
      ok: true,
      updatedAt: state.lastUpdated,
      lastUpdated: state.lastUpdated,
      refreshIntervalMinutes: 15,
      userProfile: profile || null,
      items,
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
    const userKey = String(req.body?.userKey || req.query?.user || '').trim().toLowerCase();
    const state = await refreshAiTechNews(true);
    const profile = userKey ? userNewsProfilesDb[userKey] : null;
    const items = (state.items || []).map((it) => {
      const cleaned = { ...it, body: cleanRoboticPrefixes(it.body || '') };
      if (profile) {
        const { relevanceScore, matchReason } = scoreNewsItemForUserProfile(cleaned, profile);
        return { ...cleaned, relevanceScore, matchReason };
      }
      return cleaned;
    });
    res.json({
      ok: true,
      lastUpdated: state.lastUpdated,
      userProfile: profile || null,
      items,
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
    latestVersionCode: 4,
    latestVersionName: '1.0.4',
    tag: 'Updated',
    apkUrl: 'https://paperflow.hs.vc/Paper-Flow.apk?v=1.0.4',
    title: 'Paper Flow v1.0.4 (Updated)',
    releaseNotes: 'Updated with Native Snapshot Share Sheet, AI-Personalized News Feed & Per-User Taste Database, Offline Phone Storage for Starred Flows, Natural AI News Summaries, and Background Notifications when the app is closed.'
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
          TTL: 60 * 60 * 24, // 24 hours
          urgency: 'high'
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

// Recent background notification queue for Service Workers and Android native background polling
let recentBackgroundNotifications = [];
function recordBackgroundNotification(notif) {
  if (!notif || !notif.id) return;
  if (recentBackgroundNotifications.some(n => n.id === notif.id)) return;
  recentBackgroundNotifications.unshift({
    ...notif,
    timestamp: notif.timestamp || Date.now()
  });
  if (recentBackgroundNotifications.length > 120) {
    recentBackgroundNotifications = recentBackgroundNotifications.slice(0, 120);
  }
}

// Endpoint to broadcast a developer flow alert to all subscribers
app.post('/api/push-notify-developer-flow', async (req, res) => {
  const { postId, title, body, author } = req.body || {};
  const notifPayload = {
    id: `dev_${postId || Date.now()}`,
    title: `⚡ Developer Update: ${title || 'New Developer Flow'}`,
    body: (body || 'The developer shared a new update on Paper Flow. Tap to read and reply.').slice(0, 140),
    postId: postId || '',
    targetUser: '*',
    url: `/?post=${encodeURIComponent(postId || '')}`,
    tag: `dev_${postId || Date.now()}`,
    timestamp: Date.now()
  };
  recordBackgroundNotification(notifPayload);
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
    id: `reply_${postId}_${Date.now()}`,
    title: `@${replier || 'Someone'} replied to "${(flowTitle || 'your flow').slice(0, 36)}"`,
    body: (text || 'New reply on your flow').slice(0, 140),
    postId: postId || '',
    targetUser: cleanTarget,
    url: `/?post=${encodeURIComponent(postId || '')}`,
    tag: `reply_${postId}_${Date.now()}`,
    timestamp: Date.now()
  };
  recordBackgroundNotification(notifPayload);
  sendPushToSubscribers(notifPayload, (entry) => entry.usernameLower === cleanTarget).catch(() => {});
  res.json({ ok: true });
});

// Cache of latest developer flows & background events for Service Worker and Android background service
let cachedDeveloperFlows = [];
let seenFirestoreDocIds = new Set();
let hasBootstrappedFirestoreWatch = false;
let isCheckingFirestoreEvents = false;

async function checkFirestoreForBackgroundNotifications() {
  if (isCheckingFirestoreEvents) return;
  isCheckingFirestoreEvents = true;
  try {
    const url = 'https://firestore.googleapis.com/v1/projects/memo-board-4d45b/databases/(default)/documents/posts?pageSize=80';
    const resp = await fetch(url);
    if (!resp.ok) return;
    const json = await resp.json();
    if (!json.documents || !Array.isArray(json.documents)) return;

    const devFlows = [];
    const postAuthorsById = {};

    // First pass: map post authors and developer flows
    json.documents.forEach((docItem) => {
      const fields = docItem.fields || {};
      const id = docItem.name ? docItem.name.split('/').pop() : '';
      if (!id) return;

      const authorUsername = (fields.authorUsername?.stringValue || '').trim();
      const alias = (fields.alias?.stringValue || '').trim();
      if (!id.startsWith('__')) {
        postAuthorsById[id] = {
          authorUsername: authorUsername.toLowerCase(),
          title: fields.title?.stringValue || 'your flow'
        };
      }
    });

    json.documents.forEach((docItem) => {
      const fields = docItem.fields || {};
      const id = docItem.name ? docItem.name.split('/').pop() : '';
      if (!id) return;

      const docType = fields.docType?.stringValue || '';
      const authorUsername = (fields.authorUsername?.stringValue || '').trim();
      const alias = (fields.alias?.stringValue || '').trim();
      const title = fields.title?.stringValue || null;
      const body = fields.body?.stringValue || '';
      const createdAtNum = Number(fields.createdAt?.integerValue || fields.updatedAt?.integerValue || 0);
      const ts = createdAtNum || (fields.ts?.timestampValue ? new Date(fields.ts.timestampValue).getTime() : Date.now());

      const isDevFlow = !id.startsWith('__') && (authorUsername.toLowerCase() === 'marvelist' || alias.toLowerCase() === 'marvelist');
      if (isDevFlow) {
        devFlows.push({ id, title, body, authorUsername, alias, ts });
      }

      if (!seenFirestoreDocIds.has(id)) {
        seenFirestoreDocIds.add(id);

        if (!hasBootstrappedFirestoreWatch) {
          // On initial boot, still seed the latest developer flow into recentBackgroundNotifications so polling clients can see it
          if (isDevFlow) {
            recordBackgroundNotification({
              id: `dev_${id}`,
              title: `⚡ Developer Update: ${title || 'New Flow from @Marvelist'}`,
              body: (body || 'The developer shared a new update on Paper Flow. Tap to read.').slice(0, 140),
              postId: id,
              targetUser: '*',
              url: `/?post=${encodeURIComponent(id)}`,
              tag: `dev_${id}`,
              timestamp: ts
            });
          }
          return;
        }

        // 1. New Developer Flow -> Notify Everyone
        if (isDevFlow) {
          const notifPayload = {
            id: `dev_${id}`,
            title: `⚡ Developer Update: ${title || 'New Flow from @Marvelist'}`,
            body: (body || 'The developer shared a new update on Paper Flow. Tap to read.').slice(0, 140),
            postId: id,
            targetUser: '*',
            url: `/?post=${encodeURIComponent(id)}`,
            tag: `dev_${id}`,
            timestamp: ts
          };
          recordBackgroundNotification(notifPayload);
          sendPushToSubscribers(notifPayload).catch(() => {});
        }

        // 2. New Comment / Reply -> Notify Post Author even if app is closed
        if (id.startsWith('__comment__') || docType === 'comment') {
          const postId = fields.postId?.stringValue || '';
          const commentAuthor = fields.author?.stringValue || alias || 'Someone';
          const commentAuthorLower = (fields.authorUsername?.stringValue || '').toLowerCase();
          const parentInfo = postAuthorsById[postId];
          if (parentInfo && parentInfo.authorUsername && parentInfo.authorUsername !== commentAuthorLower) {
            const notifPayload = {
              id: `comment_${id}`,
              title: `@${commentAuthor} replied to "${(parentInfo.title || 'your flow').slice(0, 36)}"`,
              body: (body || 'New reply on your flow').slice(0, 140),
              postId,
              targetUser: parentInfo.authorUsername,
              url: `/?post=${encodeURIComponent(postId)}`,
              tag: `comment_${id}`,
              timestamp: ts
            };
            recordBackgroundNotification(notifPayload);
            sendPushToSubscribers(notifPayload, (entry) => entry.usernameLower === parentInfo.authorUsername).catch(() => {});
          }
        }

        // 3. New Encrypted Paper Message or Message Request -> Notify Recipient even if app is closed
        if (id.startsWith('__pm__') || docType === 'paper_msg' || id.startsWith('__msgreq__') || docType === 'msg_request') {
          const fromUser = (fields.fromUser?.stringValue || '').toLowerCase();
          const fromDisplay = fields.fromDisplay?.stringValue || fromUser || 'Someone';
          const toUser = (fields.toUser?.stringValue || '').toLowerCase();
          const isReq = id.startsWith('__msgreq__') || docType === 'msg_request';
          if (toUser && fromUser && toUser !== fromUser) {
            const notifPayload = {
              id: `pm_${id}`,
              title: isReq ? `📩 Message Request from @${fromDisplay}` : `💬 New Paper Message from @${fromDisplay}`,
              body: isReq
                ? `@${fromDisplay} sent you an encrypted message request on Paper Flow.`
                : `@${fromDisplay} sent you an end-to-end encrypted message. Tap to open.`,
              postId: `pm:${fromUser}`,
              targetUser: toUser,
              url: `/?view=messages`,
              tag: `pm_${id}`,
              timestamp: ts
            };
            recordBackgroundNotification(notifPayload);
            sendPushToSubscribers(notifPayload, (entry) => entry.usernameLower === toUser).catch(() => {});
          }
        }
      }
    });

    hasBootstrappedFirestoreWatch = true;
    devFlows.sort((a, b) => b.ts - a.ts);
    cachedDeveloperFlows = devFlows;
  } catch (e) {
    // Graceful error ignore
  } finally {
    isCheckingFirestoreEvents = false;
  }
}

// Background poll Firestore every 20 seconds so notifications fire even when no browser tab or app is open
checkFirestoreForBackgroundNotifications().catch(() => {});
setInterval(() => {
  checkFirestoreForBackgroundNotifications().catch(() => {});
}, 20 * 1000);

app.get('/api/developer-flows/latest', (req, res) => {
  res.json({
    ok: true,
    items: cachedDeveloperFlows
  });
});

app.get('/api/background-notifications', (req, res) => {
  const user = String(req.query.user || '').trim().toLowerCase();
  const since = Number(req.query.since || 0);
  const matching = recentBackgroundNotifications.filter((n) => {
    if (since > 0 && (n.timestamp || 0) <= since) return false;
    if (n.targetUser === '*') return true;
    if (user && n.targetUser === user) return true;
    return false;
  });
  res.json({
    ok: true,
    serverTime: Date.now(),
    notifications: matching.slice(0, 20),
    latestDeveloperFlow: cachedDeveloperFlows[0] || null
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

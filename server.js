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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Developer-User');
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
const NEWS_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000; // Keep only latest 10 days of news
let aiTechNewsState = {
  items: [],
  lastUpdated: 0,
  isRefreshing: false,
  groundingSources: [],
};

function isWithinTenDaysWindow(tsMs) {
  const numeric = Number(tsMs || 0);
  if (!numeric || Number.isNaN(numeric)) return false;
  return numeric >= Date.now() - NEWS_MAX_AGE_MS;
}

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

function isReliableNewsImageUrl(url) {
  const clean = String(url || '').trim();
  if (!clean.startsWith('https://')) return false;
  if (
    /favicon|logo|icon|avatar|1x1|pixel|spacer|blank\.gif|placeholder|tracker|badge|button|banner-ad|sprite|spinner|loading|default-share|gravatar|\.svg(?:$|\?)/i.test(
      clean
    )
  ) {
    return false;
  }
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    if (!host || !host.includes('.')) return false;
    return true;
  } catch (e) {
    return false;
  }
}

const verifiedTopicImageCache = new Map();

function extractSearchQueryFromHeadline(title = '', categoryKey = '') {
  const clean = String(title || '')
    .replace(/^(?:Mind-Blowing Fact|Bizarre Fact|Red Carpet Hotties|Bollywood & Global Glamour Icons)\s*:\s*/i, '')
    .replace(/['"“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Check for well-known primary subjects first for pinpoint Wikipedia/Wikimedia image accuracy
  const priorityEntities = [
    ['christopher nolan', 'Christopher Nolan'],
    ['dune messiah', 'Timothée Chalamet'],
    ['denis villeneuve', 'Denis Villeneuve'],
    ['shah rukh khan', 'Shah Rukh Khan'],
    ['ramayana', 'Ranbir Kapoor'],
    ['ranbir kapoor', 'Ranbir Kapoor'],
    ['avengers: doomsday', 'Robert Downey Jr.'],
    ['doctor doom', 'Robert Downey Jr.'],
    ['spider-man', 'Tom Holland'],
    ['tom holland', 'Tom Holland'],
    ['sharks are older', 'Great white shark'],
    ['neutron star', 'Neutron star'],
    ['james webb space telescope', 'James Webb Space Telescope'],
    ['jwst', 'James Webb Space Telescope'],
    ['grand theft auto', 'Grand Theft Auto'],
    ['nintendo switch', 'Nintendo Switch'],
    ['sydney sweeney', 'Sydney Sweeney'],
    ['ana de armas', 'Ana de Armas'],
    ['zendaya', 'Zendaya'],
    ['deepika padukone', 'Deepika Padukone'],
    ['disha patani', 'Disha Patani'],
    ['kiara advani', 'Kiara Advani'],
  ];
  const lower = clean.toLowerCase();
  for (const [needle, query] of priorityEntities) {
    if (lower.includes(needle)) return query;
  }

  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'over', 'after', 'before', 'under', 'about',
    'amid', 'how', 'why', 'what', 'when', 'where', 'who', 'new', 'next', 'first', 'latest',
    'update', 'news', 'report', 'reveals', 'unveils', 'shares', 'locks', 'completes', 'tested',
    'breakdown', 'showdown', 'fact', 'facts', 'bizarre', 'mind-blowing', 'global', 'massive'
  ]);
  const words = clean
    .split(/[^A-Za-z0-9-]+/)
    .filter((w) => w.length >= 3 && !stop.has(w.toLowerCase()));
  return words.slice(0, 4).join(' ') || clean.slice(0, 45);
}

async function verifyAndFindClosestStoryImage(title, existingImage = '', categoryKey = '', usedImages = new Set()) {
  const cleanExisting = String(existingImage || '').trim();
  if (
    isReliableNewsImageUrl(cleanExisting) &&
    !cleanExisting.includes('images.unsplash.com') &&
    !usedImages.has(cleanExisting)
  ) {
    return { imageUrl: cleanExisting, verifiedFactSnippet: '' };
  }

  const searchQuery = extractSearchQueryFromHeadline(title, categoryKey);
  if (!searchQuery) {
    return { imageUrl: cleanExisting, verifiedFactSnippet: '' };
  }

  const cacheKey = `${categoryKey}:${searchQuery.toLowerCase()}`;
  if (verifiedTopicImageCache.has(cacheKey)) {
    const cached = verifiedTopicImageCache.get(cacheKey);
    if (cached?.imageUrl && !usedImages.has(cached.imageUrl)) {
      return cached;
    }
  }

  let foundImageUrl = '';
  let verifiedFactSnippet = '';

  // Search 1: Wikipedia MediaWiki pageimages + intro extract verification
  const wikiSearchPromise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2600);
      const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
        searchQuery
      )}&gsrlimit=4&prop=pageimages|extracts&exintro=1&explaintext=1&exchars=260&piprop=original|thumbnail&pithumbsize=1200&format=json&origin=*`;
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': 'PaperFlowNewsVerifier/1.0 (https://paperflow.app)' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      pages.sort((a, b) => (a.index || 99) - (b.index || 99));
      for (const p of pages) {
        const candidate = p?.thumbnail?.source || p?.original?.source || '';
        if (
          isReliableNewsImageUrl(candidate) &&
          !/\.(?:svg|gif|tif|tiff|pdf)(?:$|\?)/i.test(candidate) &&
          !usedImages.has(candidate)
        ) {
          return {
            imageUrl: candidate,
            extract: String(p?.extract || '').trim(),
          };
        }
      }
    } catch (e) {}
    return null;
  })();

  // Search 2: Wikimedia Commons direct photograph search
  const commonsSearchPromise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2600);
      const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
        `${searchQuery} filetype:bitmap`
      )}&gsrnamespace=6&gsrlimit=4&prop=imageinfo&iiprop=url&iiurlwidth=1200&format=json&origin=*`;
      const res = await fetch(commonsUrl, {
        headers: { 'User-Agent': 'PaperFlowNewsVerifier/1.0 (https://paperflow.app)' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      for (const p of pages) {
        const info = Array.isArray(p?.imageinfo) ? p.imageinfo[0] : null;
        const candidate = info?.thumburl || info?.url || '';
        if (
          isReliableNewsImageUrl(candidate) &&
          !/\.(?:svg|gif|tif|tiff|pdf)(?:$|\?)/i.test(candidate) &&
          !usedImages.has(candidate)
        ) {
          return candidate;
        }
      }
    } catch (e) {}
    return null;
  })();

  const [wikiRes, commonsImg] = await Promise.all([wikiSearchPromise, commonsSearchPromise]);
  if (wikiRes?.imageUrl) {
    foundImageUrl = wikiRes.imageUrl;
    verifiedFactSnippet = wikiRes.extract || '';
  } else if (commonsImg) {
    foundImageUrl = commonsImg;
  }

  const result = {
    imageUrl: foundImageUrl || cleanExisting,
    verifiedFactSnippet,
  };
  if (foundImageUrl) {
    verifiedTopicImageCache.set(cacheKey, result);
  }
  return result;
}

async function fetchArticleExcerptAndDiscussion(seed) {
  let metaDesc = '';
  const bodyParagraphs = [];
  const discussionInsights = [];

  // 1. Fetch source article HTML for og:description, og:image, twitter:image, JSON-LD image & lead paragraphs
  if (seed.url && !/\.(pdf|zip|mp4|mov|png|jpg)$/i.test(seed.url)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3200);
      const res = await fetch(seed.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) {
          const html = (await res.text()).slice(0, 180000);
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

          const ogImgMatch =
            html.match(
              /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["'][^>]+content=["'](https?:\/\/[^"']+)["']/i
            ) ||
            html.match(
              /<meta[^>]+content=["'](https?:\/\/[^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["']/i
            ) ||
            html.match(/"image"\s*:\s*(?:\{\s*"@type"\s*:\s*"ImageObject"[^}]*"url"\s*:\s*)?"(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
          if (ogImgMatch && ogImgMatch[1]) {
            const candidateImg = decodeHtmlEntities(ogImgMatch[1]).trim();
            if (isReliableNewsImageUrl(candidateImg)) {
              seed.extractedImage = candidateImg;
            }
          }

          const pRegex = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
          let match;
          while ((match = pRegex.exec(html)) !== null && bodyParagraphs.length < 5) {
            const cleaned = stripHtmlTags(match[1]).replace(/\s+/g, ' ').trim();
            if (
              cleaned.length >= 85 &&
              cleaned.length <= 720 &&
              !/cookie|privacy policy|terms of service|subscribe to our|sign up for|all rights reserved|enable javascript|advertisement/i.test(
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

  // 2. Multi-search verification & closest image lookup via Wikipedia / Wikimedia Commons if article has no direct publisher photo
  if (!seed.extractedImage || seed.extractedImage.includes('images.unsplash.com')) {
    try {
      const verified = await verifyAndFindClosestStoryImage(
        seed.title,
        seed.extractedImage || '',
        seed.categoryKey || ''
      );
      if (verified.imageUrl && isReliableNewsImageUrl(verified.imageUrl)) {
        seed.extractedImage = verified.imageUrl;
      }
      if (verified.verifiedFactSnippet && bodyParagraphs.length < 3) {
        bodyParagraphs.push(verified.verifiedFactSnippet);
      }
    } catch (e) {}
  }

  // 3. Also pull top technical commentary from HN Algolia item API if objectID is available
  if (seed.objectID) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2400);
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
            if (cleaned.length >= 65 && discussionInsights.length < 3) {
              discussionInsights.push(cleaned.slice(0, 440));
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
    extractedImage: isReliableNewsImageUrl(seed.extractedImage) ? seed.extractedImage : '',
  };
}

function cleanRoboticPrefixes(text) {
  if (!text) return '';
  return String(text)
    .replace(/^(?:📌|🔥|⚡|🔍|💡)\s*/gm, '')
    .replace(/^(?:Executive Briefing|Key Overview|Overview|Summary|TL;DR|The Unfiltered Debate)\s*:\s*/gim, '')
    .replace(/^(?:Key Report Details|Technical & Industry Breakdown|Technical & Industry Details|Key Details)\s*:\s*/gim, '')
    .replace(/^(?:Technical Context & Analysis|Why It Matters|Industry Impact|Takeaway|Why It's Shaking Up [^:]+)\s*:\s*/gim, '')
    .trim();
}

// ZERO MODERATION ON NEWS: Allow all authentic breaking, controversial, spicy, or debated stories through
function isInterestingTechStory(title, url = '') {
  const t = String(title || '').trim();
  const u = String(url || '').trim();
  if (!t || t.length < 10 || !u.startsWith('http')) return false;
  return true;
}

// Large, diverse, non-overlapping per-category image pools so fallback banners never repeat across cards
const CURATED_CATEGORY_BANNERS = {
  hollywood: [
    'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1478720568477-152d9b164e26?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1440404653325-ab127d49abc1?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1594909122845-11baa439b7bf?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1574267432553-4b4628081c31?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1524985069026-dd778a71c7b4?auto=format&fit=crop&w=1200&q=80',
  ],
  bollywood: [
    'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1570168007204-dfb528c6958f?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1567157577867-05ccb1388e66?auto=format&fit=crop&w=1200&q=80',
  ],
  cinema: [
    'https://images.unsplash.com/photo-1518676590629-3dcbd9c5a5c9?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1460881680858-30d872d5b530?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1505686994434-e3cc5abf1330?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1598899134739-24c46f58b8c0?auto=format&fit=crop&w=1200&q=80',
  ],
  marvel: [
    'https://images.unsplash.com/photo-1635805737707-575885ab0820?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1608889175123-8ee362201f81?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1612036782180-6f0b6cd846fe?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1569003339405-ea396a5a8a90?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1531259683007-016a7b628fc3?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1588497859490-85d1c17db96d?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1559535332-db9971090158?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1200&q=80',
  ],
  facts: [
    'https://images.unsplash.com/photo-1560275619-4662e36fa65c?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1457369804613-52c61a468e7d?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1461360370896-922624d12aa1?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1509228468518-180dd4864904?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=1200&q=80',
  ],
  science: [
    'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1507413245164-6160d8298b31?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1518152006812-edab29b069ac?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1614730321146-b6fa6a46bcb4?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1579154204601-01588f351e67?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1581093458791-9f3c3900df4b?auto=format&fit=crop&w=1200&q=80',
  ],
  games: [
    'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1552820728-8b83bb6b773f?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1593305841991-05c297ba4575?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1605901309584-818e25960a8f?auto=format&fit=crop&w=1200&q=80',
  ],
  hotties: [
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1469334031218-e382a71b716b?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1509631179647-0177331693ae?auto=format&fit=crop&w=1200&q=80',
  ],
  ai: [
    'https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1655720828018-edd2daec9349?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1531746790731-6c087fecd65a?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&w=1200&q=80',
  ],
  tech: [
    'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1555664424-778a1e5e1b48?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1563770660941-20978e870e26?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?auto=format&fit=crop&w=1200&q=80',
  ],
};

// Rigid single-category classification based strictly on feed source, URL domain, and headline (never body filler text)
function detectRigidCategoryKey(title = '', sourceName = '', defaultCategoryKey = '', url = '') {
  const headline = String(title || '').trim();
  const src = `${sourceName || ''} ${url || ''}`.toLowerCase();
  const cleanDefault = String(defaultCategoryKey || '').trim().toLowerCase();

  // 1. Explicit Marvel/MCU headline or source always takes 'marvel'
  if (
    /\b(marvel|mcu|avengers|spider-man|spiderman|x-men|wolverine|deadpool|doctor doom|fantastic four|daredevil|kevin feige|iron man|captain america|thor|black panther|guardians of the galaxy|secret wars|doomsday|shang-chi|blade|mutants)\b/i.test(
      headline
    ) ||
    /collider\.com\/tag\/marvel|marvel/i.test(src)
  ) {
    return 'marvel';
  }

  // 2. If the story comes from a dedicated sector feed with an explicit defaultCategoryKey, honor it strictly
  const validSectorKeys = new Set([
    'hollywood',
    'bollywood',
    'cinema',
    'marvel',
    'facts',
    'science',
    'games',
    'hotties',
    'ai',
    'tech',
  ]);
  if (validSectorKeys.has(cleanDefault) && cleanDefault !== 'tech') {
    return cleanDefault;
  }

  // 3. Domain / Publisher strict routing
  if (/bollywoodhungama|indianexpress\.com\/section\/entertainment\/bollywood|filmfare|pinkvilla/i.test(src)) {
    return 'bollywood';
  }
  if (/variety\.com|hollywoodreporter\.com|deadline\.com|indiewire\.com/i.test(src)) {
    return 'hollywood';
  }
  if (/polygon\.com|gamespot\.com|ign\.com|kotaku\.com|eurogamer\.net|pcgamer\.com/i.test(src)) {
    return 'games';
  }
  if (/smithsonianmag\.com|atlasobscura\.com|mentalfloss\.com/i.test(src)) {
    return 'facts';
  }
  if (/sciencedaily\.com|nasa\.gov|space\.com|nature\.com|newscientist\.com|phys\.org/i.test(src)) {
    return 'science';
  }
  if (/pagesix\.com|vogue\.com|gq\.com|elle\.com|harpersbazaar\.com|cosmopolitan\.com/i.test(src)) {
    return 'hotties';
  }

  // 4. Headline-only strict classification for general feeds (HN, The Verge, Ars, TechCrunch)
  if (
    /\b(bollywood|shah rukh|srk|salman khan|aamir khan|ranbir kapoor|deepika padukone|alia bhatt|priyanka chopra|hrithik roshan|karan johar|yrf|ramayana|sai pallavi|sujoy ghosh|pathaan|jawan|tollywood)\b/i.test(
      headline
    )
  ) {
    return 'bollywood';
  }
  if (
    /\b(hotties|red carpet|glamour icon|bombshell|supermodel|vogue|met gala|fashion week|sydney sweeney|ana de armas|disha patani|kiara advani|couture gown|photoshoot)\b/i.test(
      headline
    )
  ) {
    return 'hotties';
  }
  if (
    /\b(hollywood|oscars|academy award|box office|christopher nolan|denis villeneuve|dune messiah|scorsese|tarantino|warner bros|universal pictures|paramount|a24|imax|cannes|timothée chalamet|zendaya)\b/i.test(
      headline
    )
  ) {
    return 'hollywood';
  }
  if (
    /\b(gta|grand theft auto|playstation|ps5|ps6|xbox|nintendo switch|steam deck|elden ring|zelda|call of duty|fortnite|valorant|esports|rockstar games|unreal engine|game engine|gaming)\b/i.test(
      headline
    )
  ) {
    return 'games';
  }
  if (
    /\b(mind-blowing fact|bizarre fact|did you know|weird history|sharks are older|teaspoon of neutron star|guinness record|ancient mystery)\b/i.test(
      headline
    )
  ) {
    return 'facts';
  }
  if (
    /\b(nasa|james webb|jwst|exoplanet|astrophysics|black hole|supernova|quantum physics|nuclear fusion|crispr|paleontology|archaeology|cern|particle accelerator|space telescope)\b/i.test(
      headline
    )
  ) {
    return 'science';
  }
  if (
    /\b(ai|llm|gpt|chatgpt|claude|gemini|openai|anthropic|deepseek|llama|mistral|qwen|neural net|machine learning|deepmind|copilot|agentic|diffusion model|transformer|fine-tuning|reasoning model)\b/i.test(
      headline
    )
  ) {
    return 'ai';
  }

  return 'tech';
}

function getRigidTopicTagsForCategoryKey(categoryKey = 'tech', title = '') {
  switch (categoryKey) {
    case 'marvel':
      return ['Marvel & MCU'];
    case 'hollywood':
      return ['Hollywood Cinema', 'Cinema & Film'];
    case 'bollywood':
      return ['Bollywood Cinema', 'Cinema & Film'];
    case 'cinema':
      return ['Cinema & Film'];
    case 'facts':
      return ['Mind-Blowing Facts'];
    case 'science':
      return ['Science & Discovery'];
    case 'games':
      return ['Gaming & Esports'];
    case 'hotties':
      return ['Hotties & Glamour Icons'];
    case 'ai':
      if (/\b(agent|coding|copilot|cursor|mcp)\b/i.test(title)) {
        return ['AI Agents & Coding', 'LLMs & Foundation Models'];
      }
      if (/\b(robot|humanoid|waymo|autonomous)\b/i.test(title)) {
        return ['Robotics & Embodied AI', 'LLMs & Foundation Models'];
      }
      return ['LLMs & Foundation Models'];
    case 'tech':
    default:
      if (/\b(gpu|nvidia|amd|intel|tsmc|chip|semiconductor|silicon)\b/i.test(title)) {
        return ['GPUs, Chips & Hardware'];
      }
      if (/\b(linux|rust|kernel|postgres|cloud|kubernetes|security|zero-day|encryption)\b/i.test(title)) {
        return ['Systems, Cloud & Security'];
      }
      return ['Emerging Tech'];
  }
}

function detectStoryTopicTags(title, body = '', defaultTopic = '', categoryKey = '') {
  const resolvedKey =
    categoryKey ||
    detectRigidCategoryKey(title, '', defaultTopicToCategoryKey(defaultTopic), '');
  return getRigidTopicTagsForCategoryKey(resolvedKey, title);
}

function defaultTopicToCategoryKey(defaultTopic = '') {
  const t = String(defaultTopic || '').toLowerCase();
  if (t.includes('marvel')) return 'marvel';
  if (t.includes('bollywood')) return 'bollywood';
  if (t.includes('hollywood')) return 'hollywood';
  if (t.includes('cinema')) return 'cinema';
  if (t.includes('fact')) return 'facts';
  if (t.includes('science')) return 'science';
  if (t.includes('gaming') || t.includes('game')) return 'games';
  if (t.includes('hotties') || t.includes('glamour')) return 'hotties';
  if (t.includes('llm') || t.includes('ai')) return 'ai';
  return '';
}

function getCuratedNewsBannerImage(title = '', topicTags = [], extractedImage = '', categoryKey = '', usedImages = null) {
  const cleanExtracted = String(extractedImage || '').trim();
  if (
    isReliableNewsImageUrl(cleanExtracted) &&
    (!usedImages || !usedImages.has(cleanExtracted))
  ) {
    if (usedImages) usedImages.add(cleanExtracted);
    return cleanExtracted;
  }

  const resolvedKey =
    categoryKey ||
    defaultTopicToCategoryKey((Array.isArray(topicTags) && topicTags[0]) || '') ||
    detectRigidCategoryKey(title, '', '', '');
  const pool = CURATED_CATEGORY_BANNERS[resolvedKey] || CURATED_CATEGORY_BANNERS.tech;

  let hash = 0;
  const str = String(title || resolvedKey);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }

  for (let offset = 0; offset < pool.length; offset++) {
    const candidate = pool[(hash + offset) % pool.length];
    if (!usedImages || !usedImages.has(candidate)) {
      if (usedImages) usedImages.add(candidate);
      return candidate;
    }
  }

  // If all pool items were used, append a unique crop parameter so no two cards ever look identical
  const baseUrl = pool[hash % pool.length];
  const uniqueVariant = `${baseUrl}&sig=${hash % 997}`;
  if (usedImages) usedImages.add(uniqueVariant);
  return uniqueVariant;
}

function computeStoryInterestScore(seed) {
  const pts = Number(seed.points || 0);
  const cmts = Number(seed.numComments || 0);
  const t = String(seed.title || '');
  let bonus = 0;
  if (
    /\b(breakthrough|leak|controversy|lawsuit|banned|outage|hacked|zero-day|fired|resigns|open-source|launch|introducing|announcing|released|benchmark|reasoning|agent|robotics|quantum|chip|architecture|deepmind|openai|anthropic|gemini|nvidia|deepseek|llama|apple|google|meta|tesla|marvel|avengers|hollywood|bollywood|box office|trailer|gta|playstation|xbox|nintendo|nasa|cosmos|glamour|vogue)\b/i.test(
      t
    )
  ) {
    bonus += 65;
  }
  if (seed.isDirectEditorialFeed) {
    bonus += 75;
  }
  const ageHours = Math.max(1, (Date.now() - (seed.publishedAt || Date.now())) / 3600000);
  const recencyBoost = Math.max(0, 72 - ageHours) * 2.2;
  return pts * 1.4 + cmts * 1.9 + bonus + recencyBoost;
}

function buildComprehensiveSummary(seed, details, aiGeneratedSummary = '') {
  if (aiGeneratedSummary && aiGeneratedSummary.length >= 240) {
    return cleanRoboticPrefixes(aiGeneratedSummary).slice(0, 2800);
  }

  const paragraphs = [];
  const cleanMeta = details?.metaDesc || seed?.rssSummary ? cleanRoboticPrefixes(details?.metaDesc || seed?.rssSummary) : '';
  const bodyParas = Array.isArray(details?.bodyParagraphs)
    ? details.bodyParagraphs.map(cleanRoboticPrefixes).filter(Boolean)
    : [];
  const insights = Array.isArray(details?.discussionInsights)
    ? details.discussionInsights.map(cleanRoboticPrefixes).filter(Boolean)
    : [];
  const topicTags =
    seed?.topicTags ||
    detectStoryTopicTags(seed.title, cleanMeta, seed?.defaultTopic || '', seed?.categoryKey || '');
  const topicLabel = topicTags[0] || 'Culture & Tech';

  if (cleanMeta && cleanMeta.length >= 50) {
    const leadSentence =
      cleanMeta.endsWith('.') || cleanMeta.endsWith('!') || cleanMeta.endsWith('?')
        ? cleanMeta
        : `${cleanMeta}.`;
    paragraphs.push(
      `${leadSentence} First covered by ${seed.sourceName}, this story has quickly become a major talking point across the ${topicLabel.toLowerCase()} community${
        seed.points ? `, drawing ${seed.points} upvotes and ${seed.numComments || 0} active comments from readers examining every detail` : ''
      }.`
    );
  } else if (bodyParas.length > 0) {
    paragraphs.push(bodyParas[0]);
  } else {
    paragraphs.push(
      `${seed.sourceName} has published an in-depth feature on "${seed.title}", spotlighting a major moment within ${topicLabel.toLowerCase()}${
        seed.points ? ` that has already sparked ${seed.numComments || 0} discussions and ${seed.points} points` : ''
      }. The report breaks down the full backstory and why audiences and insiders are paying close attention.`
    );
  }

  for (let i = 0; i < bodyParas.length && paragraphs.length < 3; i++) {
    const p = bodyParas[i];
    if (p && !paragraphs.some((existing) => existing.includes(p.slice(0, 45)))) {
      paragraphs.push(p);
    }
  }

  if (insights.length > 0) {
    paragraphs.push(
      `Across community discussions, readers and insiders are weighing in on the story. One observer noted, "${insights[0]}"${
        insights[1] ? ` Another added perspective: "${insights[1]}"` : ''
      }`
    );
  } else if (paragraphs.join('\n\n').length < 560) {
    paragraphs.push(
      `For fans and enthusiasts following ${topicTags.join(' and ').toLowerCase()}, the story goes well beyond the initial headline. It underscores how rapidly creative production, audience expectations, and cultural trends are evolving—giving you the complete breakdown right here on Paper Flow without needing to leave the page.`
    );
  }

  return paragraphs.join('\n\n').slice(0, 2800);
}

function parseRssOrAtomItems(xmlText, sourceName, defaultTopic = '', defaultCategoryKey = '') {
  if (!xmlText || typeof xmlText !== 'string') return [];
  const items = [];
  const itemBlocks =
    xmlText.match(/<item[\s\S]*?<\/item>/gi) ||
    xmlText.match(/<entry[\s\S]*?<\/entry>/gi) ||
    [];

  for (const block of itemBlocks.slice(0, 10)) {
    const titleRaw =
      (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
        block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
        [])[1] || '';
    const title = stripHtmlTags(decodeHtmlEntities(titleRaw)).trim();

    let url =
      (block.match(/<link[^>]+href=["'](https?:\/\/[^"']+)["']/i) ||
        block.match(/<link[^>]*>(https?:\/\/[^<\s]+)<\/link>/i) ||
        block.match(/<guid[^>]*>(https?:\/\/[^<\s]+)<\/guid>/i) ||
        [])[1] || '';
    url = decodeHtmlEntities(url).trim();
    if (!title || !url.startsWith('http')) continue;

    const descRaw =
      (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
        block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
        block.match(/<summary[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/summary>/i) ||
        block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
        block.match(/<content:encoded[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i) ||
        [])[1] || '';
    const rssSummary = stripHtmlTags(decodeHtmlEntities(descRaw)).replace(/\s+/g, ' ').trim().slice(0, 620);

    const imgMatch =
      block.match(/<media:(?:content|thumbnail)[^>]+url=["'](https?:\/\/[^"']+)["']/i) ||
      block.match(/<enclosure[^>]+url=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) ||
      descRaw.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i) ||
      block.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    const candidateImage = imgMatch && imgMatch[1] ? decodeHtmlEntities(imgMatch[1]).trim() : '';
    const extractedImage = isReliableNewsImageUrl(candidateImage) ? candidateImage : '';

    const dateRaw =
      (block.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i) ||
        [])[1] || '';
    const parsedPubMs = Date.parse(dateRaw.trim()) || Date.now();
    const pubMs = parsedPubMs > Date.now() + 60000 ? Date.now() : parsedPubMs;

    if (!isWithinTenDaysWindow(pubMs)) continue;

    const categoryKey = detectRigidCategoryKey(title, sourceName, defaultCategoryKey, url);

    items.push({
      objectID: '',
      title,
      url,
      sourceName,
      defaultTopic,
      categoryKey,
      points: 92,
      numComments: 34,
      rssSummary,
      storyText: rssSummary,
      extractedImage,
      isDirectEditorialFeed: true,
      publishedAt: pubMs,
      createdAt: pubMs,
    });
  }
  return items;
}

function getGuaranteedMultiSectorSeedArticles() {
  const now = Date.now();
  const hr = 3600 * 1000;
  return [
    {
      title: 'Christopher Nolan’s Next IMAX Epic Locks Principal Cast as Practical Set Construction Begins',
      url: 'https://variety.com/2026/film/news/christopher-nolan-imax-epic-production-update/',
      sourceName: 'Variety Hollywood',
      categoryKey: 'hollywood',
      defaultTopic: 'Hollywood Cinema',
      topicTags: ['Hollywood Cinema', 'Cinema & Film'],
      publishedAt: now - 2 * hr,
      rssSummary: 'Universal Pictures and Christopher Nolan have officially locked the ensemble cast and custom 65mm IMAX camera rigs for his upcoming theatrical event film.',
      bodyParagraphs: [
        'Universal Pictures and Christopher Nolan have officially locked the ensemble cast and custom 65mm IMAX camera rigs for his upcoming theatrical event film, with massive practical sets already rising across three continents. Following the historic billion-dollar triumph of Oppenheimer, studio executives granted Nolan unprecedented creative autonomy and a dedicated theatrical window.',
        'Cinematographer Hoyte van Hoytema confirmed that the production is debuting newly engineered lighter-weight IMAX film housings capable of capturing intimate handheld dialogue scenes without sacrificing 18K-equivalent analog resolution. Sound designers are simultaneously testing a revised theatrical mix protocol so dialogue remains crystal-clear even during thunderous practical action sequences.',
        'For Hollywood exhibitors, the production represents the gold standard of event cinema—proving that audiences will pack premium large-format auditoriums months in advance when filmmakers commit to tangible, large-scale spectacle over generic green-screen backlots.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Denis Villeneuve Shares Update on Dune Messiah Screenplay and IMAX Desert Filming Schedule',
      url: 'https://www.hollywoodreporter.com/movies/movie-news/dune-messiah-filming-update-villeneuve/',
      sourceName: 'The Hollywood Reporter',
      categoryKey: 'hollywood',
      defaultTopic: 'Hollywood Cinema',
      topicTags: ['Hollywood Cinema', 'Cinema & Film'],
      publishedAt: now - 9 * hr,
      rssSummary: 'Director Denis Villeneuve revealed that pre-visualization and costume design for the conclusion of Paul Atreides’ theatrical arc are ahead of schedule.',
      bodyParagraphs: [
        'Director Denis Villeneuve revealed that pre-visualization and costume design for the conclusion of Paul Atreides’ theatrical arc are ahead of schedule, bringing back Timothée Chalamet, Zendaya, Florence Pugh, and Anya Taylor-Joy. Rather than treating the third installment as a simple sequel, Villeneuve described the script as a dramatic philosophical reckoning that subverts traditional blockbuster tropes.',
        'Production designer Patrice Vermette and composer Hans Zimmer have already begun crafting new sonic motifs and monumental architectural miniatures for Arrakis’ imperial capital. Location scouts have secured previously unfilmed desert canyons in Jordan and Abu Dhabi to give the finale a distinct visual palette.',
        'Box office analysts project the conclusion to be one of Hollywood’s biggest global releases of the decade, cementing hard sci-fi cinema as a premier theatrical draw.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Shah Rukh Khan and Sujoy Ghosh’s Action Thriller "King" Mounts Massive International Stunt Schedule',
      url: 'https://www.bollywoodhungama.com/news/bollywood/shah-rukh-khan-king-international-action-schedule/',
      sourceName: 'Bollywood Hungama',
      categoryKey: 'bollywood',
      defaultTopic: 'Bollywood Cinema',
      topicTags: ['Bollywood Cinema', 'Cinema & Film'],
      publishedAt: now - 3 * hr,
      rssSummary: 'Red Chillies Entertainment has assembled an international team of stunt coordinators across Europe and Mumbai for Shah Rukh Khan’s gritty new action drama.',
      bodyParagraphs: [
        'Red Chillies Entertainment has assembled an international team of stunt coordinators across Europe and Mumbai for Shah Rukh Khan’s gritty new action drama "King", co-starring Suhana Khan and Abhishek Bachchan as a formidable antagonist. Unlike glossy espionage spectacles, the film leans into raw, grounded hand-to-hand choreography and high-speed urban chases.',
        'Insiders close to the production note that Siddharth Anand is overseeing the large-scale action blocks while director Sujoy Ghosh anchors the taut emotional cat-and-mouse narrative. Custom anamorphic lenses and practical pyrotechnics are being used to give every set-piece a visceral theatrical punch.',
        'Trade analysts across India and the diaspora already rank "King" as Bollywood’s hottest upcoming theatrical juggernaut, with overseas distribution rights commanding record advances.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Ranbir Kapoor, Sai Pallavi & Yash’s Magnum Opus "Ramayana" Completes Epic IMAX Battle Sequences',
      url: 'https://indianexpress.com/section/entertainment/bollywood/ramayana-ranbir-kapoor-yash-imax-schedule/',
      sourceName: 'Indian Express Bollywood',
      categoryKey: 'bollywood',
      defaultTopic: 'Bollywood Cinema',
      topicTags: ['Bollywood Cinema', 'Cinema & Film'],
      publishedAt: now - 11 * hr,
      rssSummary: 'Director Nitesh Tiwari and Oscar-winning VFX studio DNEG have wrapped a landmark filming block for Part One of the pan-India cinematic adaptation.',
      bodyParagraphs: [
        'Director Nitesh Tiwari and Oscar-winning VFX studio DNEG have wrapped a landmark filming block for Part One of the pan-India cinematic adaptation starring Ranbir Kapoor as Lord Rama, Sai Pallavi as Sita, and Yash as Ravana. Filmed specifically for IMAX auditoriums, the production combines sprawling physical palace sets in Mumbai with cutting-edge virtual production volumes.',
        'In a historic musical collaboration, Academy Award winners Hans Zimmer and A.R. Rahman are co-composing the orchestral and classical Indian score, blending ancient Vedic instrumentation with thunderous cinematic brass.',
        'Exhibitors across India, North America, and the UK expect the two-part epic to redefine the global scale of Indian cinema.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1570168007204-dfb528c6958f?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Marvel Studios’ "Avengers: Doomsday" Unveils Practical Latveria Sets as Russo Brothers Tease Robert Downey Jr.’s Doctor Doom',
      url: 'https://collider.com/avengers-doomsday-doctor-doom-russo-brothers-set-update/',
      sourceName: 'Marvel & Collider',
      categoryKey: 'marvel',
      defaultTopic: 'Marvel & MCU',
      topicTags: ['Marvel & MCU'],
      publishedAt: now - 1.5 * hr,
      rssSummary: 'Joe and Anthony Russo are building massive physical castle interiors at Pinewood Studios as Robert Downey Jr. steps into the armor of Victor Von Doom.',
      bodyParagraphs: [
        'Joe and Anthony Russo are building massive physical castle interiors and forge environments at Pinewood Studios as Robert Downey Jr. steps into the armor of Victor Von Doom for Marvel Studios’ "Avengers: Doomsday". Kevin Feige confirmed that the Fantastic Four, the X-Men, and Earth’s Mightiest Heroes will collide directly with Doom’s sovereign vision for the multiverse.',
        'Rather than relying on digital helmets, Marvel’s legacy effects team has fabricated multiple hand-forged titanium-alloy masks and cloaks so Downey’s physical performance carries the same tactile weight that made Infinity War and Endgame cultural landmarks.',
        'Screenwriter Stephen McFeely structured the screenplay around Victor Von Doom as the central protagonist of the narrative—similar to how Thanos drove Infinity War—setting the stage for "Avengers: Secret Wars".'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1635805737707-575885ab0820?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Spider-Man: Brand New Day Locks Street-Level MCU Crossover Before Avengers: Secret Wars',
      url: 'https://www.hollywoodreporter.com/movies/movie-news/spider-man-4-marvel-brand-new-day-update/',
      sourceName: 'Marvel Insider',
      categoryKey: 'marvel',
      defaultTopic: 'Marvel & MCU',
      topicTags: ['Marvel & MCU'],
      publishedAt: now - 7 * hr,
      rssSummary: 'Tom Holland and director Destin Daniel Cretton are bringing practical swinging stunts back to the streets of New York for Peter Parker’s next chapter.',
      bodyParagraphs: [
        'Tom Holland and director Destin Daniel Cretton are bringing high-velocity practical wirework and rooftop stunt choreography back to the streets of New York for "Spider-Man: Brand New Day". Following the memory-wiping finale of No Way Home, Peter Parker operates entirely on his own with a hand-stitched classic red-and-blue suit.',
        'Stunt coordinators from Shang-Chi have designed continuous single-take combat sequences that showcase Spider-Man’s agility and spider-sense in tight urban environments alongside key Marvel street-level heroes.',
        'Fans have praised Marvel Studios’ decision to ground Peter’s emotional journey before he is pulled into the cosmic battlefields of Avengers: Doomsday.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1608889175123-8ee362201f81?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Mind-Blowing Fact: Sharks Are Older Than Both Saturn’s Rings and Trees on Planet Earth',
      url: 'https://www.smithsonianmag.com/smart-news/sharks-older-than-trees-and-saturns-rings/',
      sourceName: 'Smithsonian Facts',
      categoryKey: 'facts',
      defaultTopic: 'Mind-Blowing Facts',
      topicTags: ['Mind-Blowing Facts'],
      publishedAt: now - 4 * hr,
      rssSummary: 'Paleontological records and Cassini spacecraft data confirm that sharks patrolled Earth’s oceans 450 million years ago—long before the first tree or Saturn’s icy rings existed.',
      bodyParagraphs: [
        'When we picture ancient history, trees and Saturn’s iconic rings feel like permanent fixtures of nature. Yet paleontological fossil scales prove that sharks have been swimming in Earth’s oceans for roughly 450 million years, whereas the earliest true tree species (Archaeopteris) did not evolve until about 350 million years ago—giving sharks a 100-million-year head start.',
        'Even more astonishing is data from NASA’s Cassini spacecraft, which measured the mass and micrometeoroid darkening of Saturn’s rings. Astrophysicists concluded that Saturn’s bright icy rings formed between 10 million and 100 million years ago when an icy moon was torn apart by gravity—meaning dinosaurs and sharks swam under a sky where Saturn had no rings at all.',
        'Having survived four of the "Big Five" mass extinction events—including the Permian-Triassic "Great Dying" that wiped out 96% of marine species—sharks remain one of evolution’s most resilient masterpieces.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1560275619-4662e36fa65c?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Bizarre Fact: A Single Teaspoon of Neutron Star Material Weighs More Than Every Car on Earth Combined',
      url: 'https://www.nasa.gov/universe/neutron-stars-extreme-density-facts/',
      sourceName: 'Cosmic Facts & Trivia',
      categoryKey: 'facts',
      defaultTopic: 'Mind-Blowing Facts',
      topicTags: ['Mind-Blowing Facts'],
      publishedAt: now - 12 * hr,
      rssSummary: 'When a massive star collapses into a city-sized sphere just 12 miles across, gravity crushes protons and electrons together into matter of almost unimaginable density.',
      bodyParagraphs: [
        'Atoms are 99.9999999% empty space—if the nucleus of a hydrogen atom were the size of a marble on the 50-yard line of a football stadium, its electrons would be buzzing outside the stadium’s upper deck. When a giant star goes supernova and collapses into a neutron star, gravity crushes all of that empty space out of existence.',
        'The result is a sphere roughly 20 kilometers (12 miles) wide—the size of Manhattan—packing more mass than our entire Sun. A single sugar-cube or teaspoon of neutron star matter weighs approximately 4 billion tons on Earth, heavier than Mount Everest or every automobile ever manufactured by humanity.',
        'Some neutron stars, known as millisecond pulsars, also spin at up to 716 rotations per second—faster than a kitchen blender blade—while whipping magnetic fields trillions of times stronger than Earth’s.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'James Webb Space Telescope Detects Carbon-Rich Atmosphere Molecules Around Habitable-Zone Super-Earth',
      url: 'https://www.nasa.gov/missions/webb/jwst-exoplanet-atmosphere-discovery/',
      sourceName: 'NASA & ScienceDaily',
      categoryKey: 'science',
      defaultTopic: 'Science & Discovery',
      topicTags: ['Science & Discovery'],
      publishedAt: now - 2.5 * hr,
      rssSummary: 'Spectroscopic observations from JWST’s Near-Infrared Spectrograph have identified methane, carbon dioxide, and water vapor signatures on a temperate rocky world.',
      bodyParagraphs: [
        'Astronomers using the James Webb Space Telescope’s Near-Infrared Spectrograph (NIRSpec) have captured the sharpest transmission spectrum yet of a temperate sub-Neptune/super-Earth orbiting within its star’s habitable zone. By analyzing starlight filtered through the planet’s upper atmosphere during transit, researchers confirmed strong absorption bands of methane and carbon dioxide alongside water vapor.',
        'Crucially, the ratio of carbon molecules to scarce ammonia points toward a deep liquid water ocean beneath a hydrogen-rich atmosphere—a class of worlds astronomers call "Hycean" planets.',
        'Follow-up transit observations scheduled over the coming months will test for dimethyl sulfide and other disequilibrium gases that on Earth are produced almost exclusively by marine life.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Grand Theft Auto VI Technical Breakdown: How Rockstar’s RAGE 9 Engine Simulates Living Vice City Crowds & Water Physics',
      url: 'https://www.polygon.com/gaming/gta-6-rage-9-engine-physics-vice-city-breakdown/',
      sourceName: 'Polygon Gaming',
      categoryKey: 'games',
      defaultTopic: 'Gaming & Esports',
      topicTags: ['Gaming & Esports'],
      publishedAt: now - 1.8 * hr,
      rssSummary: 'Graphics engineers analyzing Rockstar Games’ latest Vice City footage highlight real-time wave fluid dynamics, per-strand hair physics, and autonomous NPC routines.',
      bodyParagraphs: [
        'Rockstar Games’ overhaul of its proprietary RAGE 9 engine for Grand Theft Auto VI represents a generational leap in open-world simulation across Leonida and Vice City. Technical analysis reveals a unified ray-traced global illumination pipeline running alongside a physically based ocean and wake solver that calculates real-time surf, boat displacement, and storm surges.',
        'Unlike previous open-world titles where pedestrians spawn with simple walk loops, GTA VI pairs procedural animation blending with localized AI behavior trees—allowing hundreds of beachgoers, traffic drivers, and nightlife crowds to react dynamically to weather shifts, music, and player chaos.',
        'Console hardware architects note that streaming such dense asset variety without loading screens pushes custom SSD decompression hardware to its absolute limits.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Nintendo Switch 2 & Next-Gen Handheld Showdown: Custom NVIDIA DLSS Upscaling Tested in Open-World Titles',
      url: 'https://www.gamespot.com/articles/next-gen-handheld-dlss-ray-tracing-performance/',
      sourceName: 'GameSpot',
      categoryKey: 'games',
      defaultTopic: 'Gaming & Esports',
      topicTags: ['Gaming & Esports'],
      publishedAt: now - 8 * hr,
      rssSummary: 'Dedicated Tensor cores inside the new portable silicon allow handheld games to output crisp 1080p handheld and 4K docked visuals without draining battery life.',
      bodyParagraphs: [
        'Hands-on technical benchmarks of next-generation portable gaming hardware demonstrate how hardware-accelerated AI upscaling has transformed handheld gaming. By rendering internal frames at 540p or 720p and reconstructing sharp edges via dedicated Tensor cores, demanding third-party engines maintain locked 60fps frame rates at a fraction of traditional wattage.',
        'Developers porting flagship RPGs and action titles noted that expanded 12GB LPDDR5X memory bandwidth eliminates the texture pop-in that plagued earlier portable consoles.',
        'With magnetic hall-effect controllers and high-refresh VRR displays becoming standard, portable gaming is rapidly closing the visual gap with living-room consoles.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Red Carpet Hotties: Sydney Sweeney, Ana de Armas & Zendaya Turn Heads in Jaw-Dropping Couture at Global Premiere Gala',
      url: 'https://pagesix.com/style/red-carpet-glamour-sydney-sweeney-ana-de-armas-zendaya-couture/',
      sourceName: 'Vogue & Page Six Glamour',
      categoryKey: 'hotties',
      defaultTopic: 'Hotties & Glamour Icons',
      topicTags: ['Hotties & Glamour Icons'],
      publishedAt: now - 1.2 * hr,
      rssSummary: 'Flashbulbs went into overdrive as Hollywood’s hottest leading ladies stepped onto the premiere carpet in custom archival metallic gowns and sculpted silhouettes.',
      bodyParagraphs: [
        'Flashbulbs went into overdrive this week as Sydney Sweeney, Ana de Armas, and Zendaya dominated the global premiere red carpet in back-to-back showstopping couture looks that immediately set social media ablaze. Sweeney channeled classic bombshell glamour in a custom liquid-silver corseted gown, while Ana de Armas stunned in a daring velvet high-slit silhouette.',
        'Stylists behind the scenes revealed that each look took over 400 hours of hand-beading in Paris and Milan ateliers, blending vintage Hollywood siren aesthetics with bold modern tailoring. Within minutes of their arrival, high-resolution portrait reels racked up tens of millions of views across fashion and pop-culture feeds.',
        'Fashion editors hailed the evening as an instant hall-of-fame red carpet moment, proving once again why this trio reigns supreme as cinema’s ultimate style and glamour icons.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Bollywood & Global Glamour Icons: Deepika Padukone, Disha Patani & Kiara Advani Set Temperature Soaring in High-Fashion Editorial',
      url: 'https://www.vogue.com/article/bollywood-glamour-icons-high-fashion-photoshoot/',
      sourceName: 'GQ & Vogue Glamour',
      categoryKey: 'hotties',
      defaultTopic: 'Hotties & Glamour Icons',
      topicTags: ['Hotties & Glamour Icons'],
      publishedAt: now - 5.5 * hr,
      rssSummary: 'From golden-hour Mediterranean resort shoots to dazzling Mumbai couture runways, Bollywood’s hottest stars deliver pure charisma in the season’s most viral cover series.',
      bodyParagraphs: [
        'Bollywood’s reigning glamour queens—Deepika Padukone, Disha Patani, and Kiara Advani—have set the internet on fire with a breathtaking new high-fashion editorial and runway showcase. Shot on location with dramatic golden-hour lighting, the feature pairs shimmering sculpted resort wear with bold haute couture.',
        'Disha Patani’s effortlessly toned athletic aesthetic and Kiara Advani’s sleek backless emerald couture look dominated trending charts within hours, while Deepika Padukone commanded the international spotlight in custom Cartier jewels and structured monochrome tailoring.',
        'Pop-culture commentators note that the crossover appeal of Indian cinema’s top stars at global fashion weeks and luxury houses has never been hotter.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'CERN Superconducting Tokamak & Fusion Labs Achieve Record Plasma Confinement Stability',
      url: 'https://www.sciencedaily.com/releases/2026/03/magnetic-fusion-plasma-confinement-record.htm',
      sourceName: 'ScienceDaily Physics',
      categoryKey: 'science',
      defaultTopic: 'Science & Discovery',
      topicTags: ['Science & Discovery'],
      publishedAt: now - 6 * hr,
      rssSummary: 'High-temperature superconducting magnets have sustained net-positive thermal plasma confinement without edge instabilities for a record duration.',
      bodyParagraphs: [
        'Experimental physicists working with next-generation high-temperature superconducting (HTS) tokamak coils have achieved a major milestone in magnetic fusion confinement, suppressing edge-localized plasma instabilities that previously eroded reactor walls.',
        'By pairing real-time magnetic field shaping with millimeter-wave gyrotron heating, the chamber sustained a 100-million-degree Celsius deuterium plasma core at unprecedented pressure density.',
        'Materials scientists note that compact REBCO superconducting tape magnets allow commercial-scale fusion demonstrators to be built at a fraction of the footprint of legacy facilities.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Frontier Reasoning Models & Multi-Agent Coding Workflows Cut Complex Repository Bug Resolution Time in Half',
      url: 'https://www.theverge.com/ai-artificial-intelligence/frontier-reasoning-models-autonomous-coding-benchmarks',
      sourceName: 'The Verge AI',
      categoryKey: 'ai',
      defaultTopic: 'LLMs & Foundation Models',
      topicTags: ['AI Agents & Coding', 'LLMs & Foundation Models'],
      publishedAt: now - 1.4 * hr,
      rssSummary: 'New test-time compute scaling and sandboxed tool execution allow frontier AI models to verify patches across multi-thousand-file codebases.',
      bodyParagraphs: [
        'Engineering teams adopting test-time compute scaling and autonomous agentic coding loops report a dramatic leap in real-world repository maintenance. Rather than generating single-shot code completions, modern reasoning models spin up isolated test sandboxes, inspect stack traces, and iteratively verify multi-file refactors before proposing a pull request.',
        'Benchmarks across production open-source repositories show that combining long-context retrieval with deterministic compiler feedback eliminates over 70% of hallucinated API calls.',
        'Senior staff engineers emphasize that human architectural review remains essential, shifting developer focus from boilerplate debugging to system design and verification.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Open-Weights Multimodal Vision-Language Models Now Run Locally on Consumer GPUs at 90 Tokens Per Second',
      url: 'https://techcrunch.com/2026/03/open-weights-multimodal-llm-local-gpu-inference/',
      sourceName: 'TechCrunch AI',
      categoryKey: 'ai',
      defaultTopic: 'LLMs & Foundation Models',
      topicTags: ['LLMs & Foundation Models'],
      publishedAt: now - 4.5 * hr,
      rssSummary: ' native 4-bit quantization and speculative decoding let developers run frontier-grade vision and audio reasoning entirely offline.',
      bodyParagraphs: [
        'A new wave of open-weights multimodal foundation models has shattered the barrier between cloud-only AI and local on-device inference. Utilizing native FP4/INT4 quantization-aware training and speculative draft decoding, a 32-billion-parameter vision-language model now runs smoothly on a single 24GB consumer GPU or unified-memory laptop.',
        'Developers can feed high-resolution UI screenshots, PDF schematics, and live audio streams directly into local inference servers with zero network latency and complete data privacy.',
        'Open-source maintainers have already landed Day-0 support across llama.cpp, vLLM, and MLX, sparking a surge of local-first desktop agents.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Next-Gen 2nm Gate-All-Around Silicon & HBM4 Memory Architecture Deliver 2.4x Memory Bandwidth Leap',
      url: 'https://arstechnica.com/gadgets/2026/03/2nm-gate-all-around-silicon-hbm4-bandwidth-deep-dive/',
      sourceName: 'Ars Technica Hardware',
      categoryKey: 'tech',
      defaultTopic: 'GPUs, Chips & Hardware',
      topicTags: ['GPUs, Chips & Hardware'],
      publishedAt: now - 2.2 * hr,
      rssSummary: 'Backside power delivery and 2048-bit HBM4 memory stacks are reshaping both data center accelerators and ultra-thin workstation laptops.',
      bodyParagraphs: [
        'Semiconductor foundries have begun volume wafer production on 2-nanometer Gate-All-Around (GAA) nanosheet transistors paired with backside power delivery networks. By routing power delivery underneath the silicon wafer rather than competing with signal interconnects on top, chip architects have reduced voltage droop and boosted clock-per-watt efficiency by 28%.',
        'Simultaneously, JEDEC-standardized HBM4 memory stacks double the interface width to 2048 bits per stack, breaking the memory-bandwidth wall that has bottlenecked high-performance computing.',
        'Hardware analysts expect these advances to trickle down into consumer desktop GPUs and fanless ARM/x86 laptops over the next product cycle.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80'
    },
    {
      title: 'Linux Kernel Landed Rust-Based NVMe & Network Drivers Alongside Post-Quantum TLS Cryptography Defaults',
      url: 'https://arstechnica.com/information-technology/2026/03/linux-kernel-rust-drivers-post-quantum-tls/',
      sourceName: 'Ars Technica Systems',
      categoryKey: 'tech',
      defaultTopic: 'Systems, Cloud & Security',
      topicTags: ['Systems, Cloud & Security'],
      publishedAt: now - 6.8 * hr,
      rssSummary: 'Memory-safe kernel subsystems and hybrid ML-KEM key exchange are now enabled across major cloud and enterprise Linux distributions.',
      bodyParagraphs: [
        'The latest mainline Linux kernel release marks a watershed moment for systems programming, graduating multiple Rust-authored storage and network driver abstractions from experimental status into production defaults. Benchmarks confirm zero throughput or tail-latency overhead compared to legacy C equivalents while eliminating entire classes of buffer-overflow vulnerabilities.',
        'In parallel, major cloud providers and browser vendors have enabled hybrid post-quantum key exchange (X25519MLKEM768) by default across TLS 1.3 handshakes to defend against harvest-now, decrypt-later attacks.',
        'Infrastructure engineers praise the release as one of the most consequential security and reliability upgrades of the decade.'
      ],
      imageUrl: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1200&q=80'
    }
  ];
}

const DEFAULT_RELIABLE_RSS_FEEDS = [
  { id: 'def_verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', defaultTopic: 'Tech & AI', categoryKey: 'tech', isDefault: true },
  { id: 'def_arstechnica', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', defaultTopic: 'Tech & AI', categoryKey: 'tech', isDefault: true },
  { id: 'def_techcrunch', name: 'TechCrunch AI & Tech', url: 'https://techcrunch.com/feed/', defaultTopic: 'Tech & AI', categoryKey: 'tech', isDefault: true },
  { id: 'def_variety', name: 'Variety Hollywood', url: 'https://variety.com/feed/', defaultTopic: 'Hollywood Cinema', categoryKey: 'hollywood', isDefault: true },
  { id: 'def_thr', name: 'The Hollywood Reporter', url: 'https://www.hollywoodreporter.com/feed/', defaultTopic: 'Hollywood Cinema', categoryKey: 'hollywood', isDefault: true },
  { id: 'def_bollywoodhungama', name: 'Bollywood Hungama', url: 'https://www.bollywoodhungama.com/rss/news.xml', defaultTopic: 'Bollywood Cinema', categoryKey: 'bollywood', isDefault: true },
  { id: 'def_indianexpress', name: 'Indian Express Bollywood', url: 'https://indianexpress.com/section/entertainment/bollywood/feed/', defaultTopic: 'Bollywood Cinema', categoryKey: 'bollywood', isDefault: true },
  { id: 'def_collidermarvel', name: 'Collider Marvel', url: 'https://collider.com/tag/marvel/feed/', defaultTopic: 'Marvel & MCU', categoryKey: 'marvel', isDefault: true },
  { id: 'def_smithsonian', name: 'Smithsonian Smart News & Facts', url: 'https://www.smithsonianmag.com/rss/smart-news/', defaultTopic: 'Mind-Blowing Facts', categoryKey: 'facts', isDefault: true },
  { id: 'def_sciencedaily', name: 'ScienceDaily Discovery', url: 'https://www.sciencedaily.com/rss/top/science.xml', defaultTopic: 'Science & Discovery', categoryKey: 'science', isDefault: true },
  { id: 'def_nasa', name: 'NASA Breaking Science', url: 'https://www.nasa.gov/news-release/feed/', defaultTopic: 'Science & Discovery', categoryKey: 'science', isDefault: true },
  { id: 'def_polygon', name: 'Polygon Gaming', url: 'https://www.polygon.com/rss/index.xml', defaultTopic: 'Gaming & Esports', categoryKey: 'games', isDefault: true },
  { id: 'def_gamespot', name: 'GameSpot News', url: 'https://www.gamespot.com/feeds/news/', defaultTopic: 'Gaming & Esports', categoryKey: 'games', isDefault: true },
  { id: 'def_pagesix', name: 'Page Six Celebrity & Glamour', url: 'https://pagesix.com/feed/', defaultTopic: 'Hotties & Glamour Icons', categoryKey: 'hotties', isDefault: true },
];

const CUSTOM_NEWS_SOURCES_FILE = path.join(__dirname, 'custom_news_sources.json');

function loadCustomNewsSources() {
  try {
    if (fs.existsSync(CUSTOM_NEWS_SOURCES_FILE)) {
      const raw = fs.readFileSync(CUSTOM_NEWS_SOURCES_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[NewsSources] Error loading custom sources:', err.message);
  }
  return [];
}

function saveCustomNewsSources(sources) {
  try {
    fs.writeFileSync(CUSTOM_NEWS_SOURCES_FILE, JSON.stringify(sources, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[NewsSources] Error saving custom sources:', err.message);
    return false;
  }
}

async function fetchLiveTechArticlesSeed() {
  const candidates = [];
  const seenUrls = new Set();
  const usedSeedImages = new Set();

  // Seed guaranteed multi-sector stories first so every category (Hollywood, Bollywood, Marvel, Facts, Science, Games, Hotties) is always rich
  const guaranteedSeeds = getGuaranteedMultiSectorSeedArticles();
  await Promise.allSettled(
    guaranteedSeeds.map(async (gItem) => {
      try {
        const verified = await verifyAndFindClosestStoryImage(
          gItem.title,
          '',
          gItem.categoryKey,
          usedSeedImages
        );
        if (verified.imageUrl && isReliableNewsImageUrl(verified.imageUrl)) {
          gItem.extractedImage = verified.imageUrl;
          gItem.imageUrl = verified.imageUrl;
          usedSeedImages.add(verified.imageUrl);
        }
      } catch (e) {}
    })
  );

  for (const gItem of guaranteedSeeds) {
    seenUrls.add(gItem.url);
    gItem.interestScore = computeStoryInterestScore({ ...gItem, points: 140, numComments: 48, isDirectEditorialFeed: true });
    candidates.push(gItem);
  }

  // 1. Direct Authentic & Reliable Top-Tier Multi-Sector Editorial Feeds (Default + Custom Developer Feeds)
  const customFeeds = loadCustomNewsSources();
  const allEditorialFeeds = [...DEFAULT_RELIABLE_RSS_FEEDS, ...customFeeds];

  // 2. High-velocity Hacker News Front Page & Breaking AI/Tech queries within the last 10 days
  const tenDaysAgoUnix = Math.floor((Date.now() - NEWS_MAX_AGE_MS) / 1000);
  const hnQueries = [
    `https://hn.algolia.com/api/v1/search?tags=front_page&numericFilters=created_at_i>${tenDaysAgoUnix}&hitsPerPage=18`,
    `https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&numericFilters=points>10,created_at_i>${tenDaysAgoUnix}&hitsPerPage=10`,
    `https://hn.algolia.com/api/v1/search_by_date?query=OpenAI&tags=story&numericFilters=points>8,created_at_i>${tenDaysAgoUnix}&hitsPerPage=8`,
    `https://hn.algolia.com/api/v1/search_by_date?query=Gemini&tags=story&numericFilters=points>8,created_at_i>${tenDaysAgoUnix}&hitsPerPage=8`,
  ];

  await Promise.allSettled([
    ...allEditorialFeeds.map(async (feed) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4200);
        const res = await fetch(feed.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; PaperFlowNewsReader/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml, */*',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return;
        const xml = await res.text();
        const parsedItems = parseRssOrAtomItems(xml, feed.name, feed.defaultTopic, feed.categoryKey);
        for (const item of parsedItems.slice(0, 8)) {
          if (!item.url || seenUrls.has(item.url)) continue;
          if (!isWithinTenDaysWindow(item.publishedAt)) continue;
          if (!isInterestingTechStory(item.title, item.url)) continue;
          seenUrls.add(item.url);
          item.categoryKey = feed.categoryKey || item.categoryKey || detectRigidCategoryKey(item.title, feed.name, feed.categoryKey, item.url);
          item.topicTags = getRigidTopicTagsForCategoryKey(item.categoryKey, item.title);
          item.imageUrl = getCuratedNewsBannerImage(item.title, item.topicTags, item.extractedImage, item.categoryKey, usedSeedImages);
          item.interestScore = computeStoryInterestScore(item);
          candidates.push(item);
        }
      } catch (e) {}
    }),
    ...hnQueries.map(async (qUrl) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4200);
        const res = await fetch(qUrl, {
          headers: { 'User-Agent': 'PaperFlow-NewsBot/1.0' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.hits)) {
          for (const hit of data.hits.slice(0, 8)) {
            const url = hit.url;
            const title = (hit.title || '').trim();
            if (!url || !title || seenUrls.has(url)) continue;
            const pubMs = hit.created_at_i
              ? hit.created_at_i * 1000
              : hit.created_at
              ? Date.parse(hit.created_at) || Date.now()
              : Date.now();
            if (!isWithinTenDaysWindow(pubMs)) continue;
            const points = Number(hit.points || 0);
            const numComments = Number(hit.num_comments || 0);
            if (!isInterestingTechStory(title, url)) continue;
            seenUrls.add(url);
            const sourceName = extractDomainName(url);
            const categoryKey = detectRigidCategoryKey(title, sourceName, '', url);
            const topicTags = getRigidTopicTagsForCategoryKey(categoryKey, title);
            const seedObj = {
              objectID: hit.objectID || '',
              title,
              url,
              sourceName,
              categoryKey,
              points,
              numComments,
              storyText: hit.story_text ? stripHtmlTags(hit.story_text) : '',
              topicTags,
              imageUrl: getCuratedNewsBannerImage(title, topicTags, '', categoryKey, usedSeedImages),
              publishedAt: pubMs,
              createdAt: pubMs,
            };
            seedObj.interestScore = computeStoryInterestScore(seedObj);
            candidates.push(seedObj);
          }
        }
      } catch (e) {}
    }),
  ]);

  candidates.sort((a, b) => (b.interestScore || 0) - (a.interestScore || 0));
  const curatedTop = candidates.slice(0, 60);
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
  const usedMergeImages = new Set();

  for (const item of [...newItems, ...aiTechNewsState.items]) {
    if (!item || !item.id) continue;
    const itemTs = item.publishedAt || item.createdAt || item.ts || 0;
    if (!isWithinTenDaysWindow(itemTs)) continue;
    const cleanedBody = cleanRoboticPrefixes(item.body || '');
    const prev = mergedMap.get(item.id);
    const categoryKey =
      item.categoryKey ||
      prev?.categoryKey ||
      detectRigidCategoryKey(
        item.title,
        item.sourceName || '',
        defaultTopicToCategoryKey((Array.isArray(item.topicTags) && item.topicTags[0]) || item.topic || ''),
        item.linkUrl || ''
      );
    const tags = getRigidTopicTagsForCategoryKey(categoryKey, item.title);
    const candidateImg = item.extractedImage || item.imageUrl || prev?.imageUrl || '';
    const resolvedImage = getCuratedNewsBannerImage(
      item.title,
      tags,
      candidateImg,
      categoryKey,
      usedMergeImages
    );
    const normalizedItem = {
      ...item,
      body: cleanedBody,
      categoryKey,
      topic: tags[0] || 'Technology',
      topicTags: tags,
      imageUrl: resolvedImage,
    };
    if (!prev || (cleanedBody && (!prev.body || cleanedBody.length >= prev.body.length))) {
      mergedMap.set(item.id, normalizedItem);
    }
  }
  aiTechNewsState.items = Array.from(mergedMap.values())
    .filter((it) => isWithinTenDaysWindow(it.publishedAt || it.createdAt || it.ts))
    .sort((a, b) => (b.publishedAt || b.createdAt || 0) - (a.publishedAt || a.createdAt || 0))
    .slice(0, 64);
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
        liveSeeds.slice(0, 32).map(async (s) => {
          const details = await fetchArticleExcerptAndDiscussion(s);
          enrichedDetailsMap.set(s.url, details);
        })
      );

      // Immediately upgrade existing items with scraped article paragraphs, verified Wikipedia/og:image & HN commentary
      const upgradedSeedItems = [];
      const usedEnrichImages = new Set();
      for (let i = 0; i < liveSeeds.length && upgradedSeedItems.length < 54; i++) {
        const s = liveSeeds[i];
        const pubMs = s.publishedAt || s.createdAt || now - i * 180000;
        if (!isWithinTenDaysWindow(pubMs)) continue;
        const categoryKey =
          s.categoryKey || detectRigidCategoryKey(s.title, s.sourceName, '', s.url);
        const fetchedDetails = enrichedDetailsMap.get(s.url) || {};
        const details = {
          ...fetchedDetails,
          bodyParagraphs:
            Array.isArray(fetchedDetails.bodyParagraphs) && fetchedDetails.bodyParagraphs.length > 0
              ? fetchedDetails.bodyParagraphs
              : Array.isArray(s.bodyParagraphs)
              ? s.bodyParagraphs
              : [],
        };
        const comprehensiveBody = buildComprehensiveSummary(s, details);
        const topicTags = getRigidTopicTagsForCategoryKey(categoryKey, s.title);
        const bannerImg = getCuratedNewsBannerImage(
          s.title,
          topicTags,
          details.extractedImage || s.extractedImage || s.imageUrl,
          categoryKey,
          usedEnrichImages
        );
        upgradedSeedItems.push({
          id: makeDeterministicNewsId(s.title, s.url),
          title: s.title.slice(0, 118),
          body: comprehensiveBody,
          imageUrl: bannerImg,
          tag: 'news',
          categoryKey,
          topic: topicTags[0] || 'Technology',
          topicTags,
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
          ? `\nHere are candidate live articles from authentic, reliable sources:\n` +
            liveSeeds
              .slice(0, 18)
              .map((s, i) => {
                const det = enrichedDetailsMap.get(s.url);
                const snippet = det?.metaDesc || s.rssSummary || det?.bodyParagraphs?.[0] || s.bodyParagraphs?.[0] || '';
                const bodyExtra = det?.bodyParagraphs?.[1] || s.bodyParagraphs?.[1] || '';
                const insight = det?.discussionInsights?.[0] || '';
                return `${i + 1}. "${s.title}" — Source: ${s.sourceName} (${s.points || 0} pts, ${s.numComments || 0} comments) — Published: ${new Date(
                  s.publishedAt
                ).toISOString()} — URL: ${s.url}${snippet ? ` — Lead: ${snippet.slice(0, 280)}` : ''}${bodyExtra ? ` — Detail: ${bodyExtra.slice(0, 240)}` : ''}${insight ? ` — Reader Take: ${insight.slice(0, 200)}` : ''}`;
              })
              .join('\n')
          : '';

      const prompt = `You are a seasoned, deeply knowledgeable human editor writing self-contained, deeply informative articles for Paper Flow readers across Tech, AI, Cinema (Hollywood & Bollywood), Marvel, Science, Facts, Games, and Culture.
Your goal is to make each story so complete, natural, well-explained, and engaging that the reader feels completely satisfied reading it right here on Paper Flow without needing to leave the website.
${seedContext}

WRITING STYLE RULES (CRITICAL):
1. Write like a thoughtful, articulate human journalist. Warm, lucid, specific, and conversational—never robotic, never corporate PR, and NEVER start paragraphs with emojis like 🔥 or ⚡ or labels like "Summary:" or "Why it matters:".
2. Include all the key facts, numbers, behind-the-scenes details, background context, and real-world implications so the reader gets the entire story right on the page.
3. Structure each article into 3 to 4 rich, flowing paragraphs separated by "\\n\\n":
   - Paragraph 1: What happened, who announced or discovered it, and the core context behind the story.
   - Paragraph 2: The concrete details, production or technical breakdown, numbers, or changes under the hood.
   - Paragraph 3: How fans, engineers, researchers, and industry insiders are reacting, including debates and what comes next.

Return ONLY a valid JSON array where each object has:
- "title": Clear, compelling, authentic headline (max 114 chars)
- "summary": Complete, natural 3-to-4 paragraph human-written article separated by "\\n\\n" (850 to 1,750 chars)
- "sourceName": Publisher name
- "sourceUrl": Direct https:// URL from the candidate list
- "publishedAt": ISO 8601 timestamp string
- "topic": Primary category label
- "topicTags": Array of 1 to 2 specific topic labels

Output strictly the raw JSON array and nothing else.`;

      const zeroModSafetySettings = [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ];

      let response;
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: { safetySettings: zeroModSafetySettings },
        });
      } catch (primaryErr) {
        response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: { safetySettings: zeroModSafetySettings },
        });
      }

      const parsed = parseJsonArrayFromText(response?.text || '');
      if (Array.isArray(parsed) && parsed.length > 0) {
        const usedAiImages = new Set();
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
            if (!isWithinTenDaysWindow(pubMs)) return null;

            const sourceName =
              String(item.sourceName || '').trim() || exactSeed?.sourceName || extractDomainName(sourceUrl);
            const details = enrichedDetailsMap.get(sourceUrl) || {};
            const fullSummary =
              rawSummary.length >= 420
                ? rawSummary.slice(0, 2800)
                : buildComprehensiveSummary(
                    exactSeed || { title, url: sourceUrl, sourceName },
                    details,
                    rawSummary
                  );
            const categoryKey =
              exactSeed?.categoryKey ||
              detectRigidCategoryKey(title, sourceName, '', sourceUrl);
            const topicTags = getRigidTopicTagsForCategoryKey(categoryKey, title);
            const topic = topicTags[0] || 'Technology';
            const bannerImg = getCuratedNewsBannerImage(
              title,
              topicTags,
              details.extractedImage || exactSeed?.extractedImage || exactSeed?.imageUrl,
              categoryKey,
              usedAiImages
            );

            return {
              id: makeDeterministicNewsId(exactSeed?.title || title, sourceUrl),
              title: title.slice(0, 118),
              body: fullSummary,
              imageUrl: bannerImg,
              tag: 'news',
              categoryKey,
              topic,
              topicTags,
              interestScore: (exactSeed?.interestScore || 60) + 35,
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
    aiTechNewsState.items.length >= 24 &&
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
        const usedFastImages = new Set();
        for (let i = 0; i < liveSeeds.length && fastItems.length < 54; i++) {
          const s = liveSeeds[i];
          const pubMs = s.publishedAt || s.createdAt || now - i * 180000;
          const categoryKey =
            s.categoryKey || detectRigidCategoryKey(s.title, s.sourceName, '', s.url);
          const comprehensiveBody = buildComprehensiveSummary(s, {
            bodyParagraphs: Array.isArray(s.bodyParagraphs) ? s.bodyParagraphs : [],
            metaDesc: s.rssSummary || '',
          });
          const topicTags = getRigidTopicTagsForCategoryKey(categoryKey, s.title);
          const bannerImg = getCuratedNewsBannerImage(
            s.title,
            topicTags,
            s.extractedImage || s.imageUrl,
            categoryKey,
            usedFastImages
          );

          fastItems.push({
            id: makeDeterministicNewsId(s.title, s.url),
            title: s.title.slice(0, 118),
            body: comprehensiveBody,
            imageUrl: bannerImg,
            tag: 'news',
            categoryKey,
            topic: topicTags[0] || 'Technology',
            topicTags,
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

const proxiedImageCache = new Map();
app.get('/api/image-proxy', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      res.status(400).send('Invalid image url');
      return;
    }
    const cached = proxiedImageCache.get(rawUrl);
    if (cached && cached.buffer && (Date.now() - cached.createdAt < 3600 * 1000)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', cached.contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(cached.buffer);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    const upstream = await fetch(rawUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      res.status(upstream.status).send('Upstream image error');
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const arrBuf = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrBuf);
    if (buffer.length > 0 && buffer.length < 8 * 1024 * 1024) {
      proxiedImageCache.set(rawUrl, { buffer, contentType, createdAt: Date.now() });
      if (proxiedImageCache.size > 60) {
        const firstKey = proxiedImageCache.keys().next().value;
        if (firstKey) proxiedImageCache.delete(firstKey);
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    res.status(502).send('Failed to proxy image');
  }
});

app.get('/api/ai-tech-news', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const userKey = String(req.query.user || '').trim().toLowerCase();
    const state = await refreshAiTechNews(force);
    const profile = userKey ? userNewsProfilesDb[userKey] : null;

    const items = (state.items || [])
      .filter((it) => isWithinTenDaysWindow(it.publishedAt || it.createdAt || it.ts))
      .map((it) => {
        const cleaned = {
          ...it,
          body: cleanRoboticPrefixes(it.body || ''),
          imageUrl: getCuratedNewsBannerImage(it.title, it.topicTags, it.imageUrl),
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
      items: (aiTechNewsState.items || []).filter((it) =>
        isWithinTenDaysWindow(it.publishedAt || it.createdAt || it.ts)
      ),
    });
  }
});

app.post('/api/ai-tech-news/refresh', async (req, res) => {
  try {
    const userKey = String(req.body?.userKey || req.query?.user || '').trim().toLowerCase();
    const state = await refreshAiTechNews(true);
    const profile = userKey ? userNewsProfilesDb[userKey] : null;
    const items = (state.items || [])
      .filter((it) => isWithinTenDaysWindow(it.publishedAt || it.createdAt || it.ts))
      .map((it) => {
        const cleaned = {
          ...it,
          body: cleanRoboticPrefixes(it.body || ''),
          imageUrl: getCuratedNewsBannerImage(it.title, it.topicTags, it.imageUrl),
        };
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
      items: (aiTechNewsState.items || []).filter((it) =>
        isWithinTenDaysWindow(it.publishedAt || it.createdAt || it.ts)
      ),
    });
  }
});

// ── DEVELOPER NEWS SOURCES MANAGEMENT (@marvelist) ───────────────────────────
function isAuthorizedDeveloper(req) {
  const username = String(
    req.body?.usernameLower ||
    req.body?.username ||
    req.query?.user ||
    req.query?.username ||
    req.headers['x-developer-user'] ||
    ''
  ).trim().toLowerCase();
  return username === 'marvelist';
}

app.get('/api/developer/news-sources', (req, res) => {
  try {
    const customSources = loadCustomNewsSources();
    res.json({
      ok: true,
      defaultSources: DEFAULT_RELIABLE_RSS_FEEDS,
      customSources,
      totalCount: DEFAULT_RELIABLE_RSS_FEEDS.length + customSources.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/developer/news-sources', async (req, res) => {
  try {
    if (!isAuthorizedDeveloper(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized: news source addition is restricted exclusively to the developer (@marvelist).',
      });
    }

    const { name, url, categoryKey, defaultTopic } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanUrl = String(url || '').trim();
    const cleanCategoryKey = String(categoryKey || '').trim().toLowerCase();
    const cleanDefaultTopic = String(defaultTopic || '').trim();

    if (!cleanName) {
      return res.status(400).json({ ok: false, error: 'Source name is required.' });
    }
    if (!cleanUrl || !/^https?:\/\/.+/i.test(cleanUrl)) {
      return res.status(400).json({ ok: false, error: 'A valid HTTP/HTTPS RSS or Atom feed URL is required.' });
    }

    const validCategoryKeys = ['cinema', 'hollywood', 'bollywood', 'marvel', 'facts', 'science', 'games', 'hotties', 'tech'];
    const resolvedCategoryKey = validCategoryKeys.includes(cleanCategoryKey) ? cleanCategoryKey : 'tech';

    const currentSources = loadCustomNewsSources();
    const existingIndex = currentSources.findIndex(s => s.url.toLowerCase() === cleanUrl.toLowerCase());
    
    const newSource = {
      id: existingIndex >= 0 ? currentSources[existingIndex].id : `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      url: cleanUrl,
      categoryKey: resolvedCategoryKey,
      defaultTopic: cleanDefaultTopic || '',
      addedBy: 'marvelist',
      addedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      currentSources[existingIndex] = newSource;
    } else {
      currentSources.push(newSource);
    }

    saveCustomNewsSources(currentSources);

    // Trigger instant background refresh so new sources populate immediately
    refreshAiTechNews(true).catch(err => {
      console.warn('[NewsSources] Background refresh after adding source had an issue:', err.message);
    });

    res.json({
      ok: true,
      message: `Source "${cleanName}" added successfully. Stories are now being polled and synced.`,
      addedSource: newSource,
      customSources: currentSources,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/developer/news-sources/:id', (req, res) => {
  try {
    if (!isAuthorizedDeveloper(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized: news source removal is restricted exclusively to the developer (@marvelist).',
      });
    }

    const sourceId = String(req.params.id || '').trim();
    if (!sourceId) {
      return res.status(400).json({ ok: false, error: 'Source ID is required.' });
    }

    const currentSources = loadCustomNewsSources();
    const filtered = currentSources.filter(s => s.id !== sourceId);
    if (filtered.length === currentSources.length) {
      return res.status(404).json({ ok: false, error: 'Custom source not found.' });
    }

    saveCustomNewsSources(filtered);

    res.json({
      ok: true,
      message: 'Source deleted successfully.',
      customSources: filtered,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/developer/news-sources/test', async (req, res) => {
  try {
    if (!isAuthorizedDeveloper(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized: developer access required (@marvelist).',
      });
    }

    const { url, name, categoryKey, defaultTopic } = req.body || {};
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl || !/^https?:\/\/.+/i.test(cleanUrl)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid HTTP/HTTPS URL.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const fetchRes = await fetch(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PaperFlowNewsReader/1.0)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!fetchRes.ok) {
      return res.status(400).json({
        ok: false,
        error: `Feed responded with HTTP status ${fetchRes.status} (${fetchRes.statusText})`,
      });
    }

    const xml = await fetchRes.text();
    const parsed = parseRssOrAtomItems(xml, name || 'Test Source', defaultTopic || '', categoryKey || '');

    res.json({
      ok: true,
      count: parsed.length,
      sampleItems: parsed.slice(0, 3).map(item => ({
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        categoryKey: item.categoryKey,
        hasImage: Boolean(item.extractedImage),
      })),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: `Could not fetch or parse feed: ${err.message}`,
    });
  }
});

// ── ROBOTS.TXT, SITEMAP.XML & GOOGLE SEARCH INDEXING ENGINE ─────────────────
let cachedSitemapXml = '';
let sitemapLastGenerated = 0;
const SITEMAP_CACHE_TTL = 15 * 60 * 1000; // Cache sitemap for 15 minutes

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function buildDynamicSitemap(baseUrl) {
  const today = new Date().toISOString().split('T')[0];
  const urls = [];

  // 1. Root & Primary Views
  urls.push({
    loc: `${baseUrl}/`,
    lastmod: today,
    changefreq: 'hourly',
    priority: '1.0',
    img: `${baseUrl}/pwa-512x512.png`,
    title: 'Paper Flow — Anonymous & Open Community Board'
  });

  urls.push({
    loc: `${baseUrl}/?view=board`,
    lastmod: today,
    changefreq: 'hourly',
    priority: '0.9'
  });

  urls.push({
    loc: `${baseUrl}/?view=news`,
    lastmod: today,
    changefreq: 'hourly',
    priority: '0.9'
  });

  // 2. Category Board Views
  const categories = [
    { cat: 'confessions', label: 'Confessions & Secrets' },
    { cat: 'stories', label: 'Stories & Experiences' },
    { cat: 'opinions', label: 'Opinions & Perspectives' },
    { cat: 'news', label: 'Tech & AI News' },
    { cat: 'questions', label: 'Community Questions' },
    { cat: 'updates', label: 'Changelog & Updates' }
  ];

  for (const c of categories) {
    urls.push({
      loc: `${baseUrl}/?category=${c.cat}`,
      lastmod: today,
      changefreq: 'daily',
      priority: '0.85'
    });
  }

  // 3. Android APK & Obsidian Sudoku Downloads
  urls.push({
    loc: `${baseUrl}/Paper-Flow.apk`,
    lastmod: today,
    changefreq: 'weekly',
    priority: '0.75'
  });

  urls.push({
    loc: `${baseUrl}/Obsidian-Sudoku.apk`,
    lastmod: today,
    changefreq: 'weekly',
    priority: '0.75'
  });

  // 4. Dynamic Firestore Posts (Up to 100 most recent public flows)
  try {
    const fsRes = await fetch(
      'https://firestore.googleapis.com/v1/projects/memo-board-4d45b/databases/(default)/documents/posts?pageSize=100',
      { headers: { 'Accept': 'application/json' } }
    );
    if (fsRes.ok) {
      const fsData = await fsRes.json();
      if (fsData && Array.isArray(fsData.documents)) {
        for (const doc of fsData.documents) {
          const docId = (doc.name || '').split('/').pop();
          if (!docId) continue;
          const fields = doc.fields || {};
          const author = fields.authorUsername?.stringValue || fields.alias?.stringValue || 'Anonymous';
          const rawBody = (fields.body?.stringValue || '').slice(0, 70).replace(/\s+/g, ' ').trim();
          const imageUrl = fields.imageUrl?.stringValue || fields.photoUrl?.stringValue || null;
          const updateTime = doc.updateTime ? doc.updateTime.split('T')[0] : today;

          urls.push({
            loc: `${baseUrl}/?post=${encodeURIComponent(docId)}`,
            lastmod: updateTime,
            changefreq: 'daily',
            priority: '0.7',
            img: imageUrl,
            title: rawBody || `Flow by ${author}`
          });
        }
      }
    }
  } catch (err) {
    console.error('Error fetching Firestore documents for sitemap:', err);
  }

  // 5. AI-Summarized Tech & AI News Items
  if (aiTechNewsState && Array.isArray(aiTechNewsState.items)) {
    for (const item of aiTechNewsState.items) {
      if (item && item.id) {
        urls.push({
          loc: `${baseUrl}/?post=${encodeURIComponent(item.id)}`,
          lastmod: today,
          changefreq: 'weekly',
          priority: '0.65',
          img: item.imageUrl || null,
          title: item.title || 'AI News'
        });
      }
    }
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n';
  xml += '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';

  for (const u of urls) {
    xml += '  <url>\n';
    xml += `    <loc>${escapeXml(u.loc)}</loc>\n`;
    xml += `    <lastmod>${u.lastmod}</lastmod>\n`;
    xml += `    <changefreq>${u.changefreq}</changefreq>\n`;
    xml += `    <priority>${u.priority}</priority>\n`;
    if (u.img) {
      xml += '    <image:image>\n';
      xml += `      <image:loc>${escapeXml(u.img)}</image:loc>\n`;
      if (u.title) {
        xml += `      <image:title>${escapeXml(u.title)}</image:title>\n`;
      }
      xml += '    </image:image>\n';
    }
    xml += '  </url>\n';
  }

  xml += '</urlset>\n';
  return xml;
}

app.get('/robots.txt', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.type('text/plain').send(
    [
      '# Paper Flow — Robots.txt for Google Search & Web Crawlers',
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      '',
      'User-agent: Googlebot',
      'Allow: /',
      'Allow: /sitemap.xml',
      'Allow: /icon.svg',
      'Allow: /pwa-192x192.png',
      'Allow: /pwa-512x512.png',
      'Allow: /manifest.json',
      '',
      'User-agent: Googlebot-Image',
      'Allow: /',
      '',
      'User-agent: Bingbot',
      'Allow: /',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join('\n')
  );
});

app.get(['/sitemap.xml', '/sitemap_index.xml', '/sitemap'], async (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'all');

  const now = Date.now();
  if (cachedSitemapXml && now - sitemapLastGenerated < SITEMAP_CACHE_TTL) {
    res.send(cachedSitemapXml);
    return;
  }

  try {
    const freshXml = await buildDynamicSitemap(baseUrl);
    cachedSitemapXml = freshXml;
    sitemapLastGenerated = now;
    res.send(freshXml);
  } catch (err) {
    if (cachedSitemapXml) {
      res.send(cachedSitemapXml);
    } else {
      res.status(500).type('text/plain').send('Error generating sitemap');
    }
  }
});

// Google Search Console Site Verification HTML Route (e.g., /google1234567890abcdef.html)
app.get('/google:code([a-zA-Z0-9_-]+).html', (req, res) => {
  const code = req.params.code;
  res.type('text/html').send(`google-site-verification: google${code}.html`);
});

// Digital Asset Links for Android App Google Search Indexing
app.get('/.well-known/assetlinks.json', (req, res) => {
  const filePath = path.join(__dirname, '.well-known', 'assetlinks.json');
  if (fs.existsSync(filePath)) {
    res.type('application/json').sendFile(filePath);
  } else {
    res.status(404).send('Not found');
  }
});

// Security.txt for Web Crawlers & Security Audits
app.get('/.well-known/security.txt', (req, res) => {
  const filePath = path.join(__dirname, '.well-known', 'security.txt');
  if (fs.existsSync(filePath)) {
    res.type('text/plain').sendFile(filePath);
  } else {
    res.status(404).send('Not found');
  }
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
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

app.get('/Paper-Flow.apk', serveApkFile);
app.get('/public/Paper-Flow.apk', serveApkFile);
app.get('/download/Paper-Flow.apk', serveApkFile);
app.get('/api/download-apk', serveApkFile);

function serveSudokuApkFile(req, res) {
  const rootApk = path.join(__dirname, 'Obsidian-Sudoku.apk');
  const publicApk = path.join(__dirname, 'public', 'Obsidian-Sudoku.apk');
  const downloadApk = path.join(__dirname, 'download', 'Obsidian-Sudoku.apk');
  const targetApk = fs.existsSync(rootApk) ? rootApk : (fs.existsSync(downloadApk) ? downloadApk : publicApk);

  if (!fs.existsSync(targetApk)) {
    res.redirect(302, 'https://github.com/ArnavSri21/SudokuClash/releases/download/v1.0.0/Obsidian-Sudoku.apk');
    return;
  }

  res.sendFile(targetApk, {
    acceptRanges: true,
    etag: true,
    lastModified: true,
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="Obsidian-Sudoku.apk"',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

app.get('/Obsidian-Sudoku.apk', serveSudokuApkFile);
app.get('/public/Obsidian-Sudoku.apk', serveSudokuApkFile);
app.get('/download/Obsidian-Sudoku.apk', serveSudokuApkFile);
app.get('/download/obsidian-sudoku-debug.apk', serveSudokuApkFile);
app.get('/api/download-sudoku-apk', serveSudokuApkFile);

app.get('/api/sudoku-info', (req, res) => {
  res.json({
    appName: 'Obsidian Sudoku',
    versionName: '1.0.0',
    buildNumber: 8,
    tag: 'Updated',
    updatedAt: '2026-11-04T07:05:45Z',
    fileSize: 24238267,
    apkUrl: '/Obsidian-Sudoku.apk?v=1.0.0-b8',
    githubFallbackUrl: 'https://github.com/ArnavSri21/SudokuClash/releases/download/v1.0.0/Obsidian-Sudoku.apk',
    directBuildUrl: 'https://github.com/ArnavSri21/SudokuClash/releases/download/debug-build-8-3a5adcd/Obsidian-Sudoku.apk',
    releaseNotes: 'Updated Obsidian Sudoku build with sleek animations, high-contrast grid lines, instant note-taking, and performance improvements.'
  });
});

app.get('/api/app-version', (req, res) => {
  res.json({
    latestVersionCode: 4,
    latestVersionName: '1.0.5',
    tag: 'Updated',
    apkUrl: 'https://paperflow.hs.vc/Paper-Flow.apk?v=1.0.5',
    title: 'Paper Flow v1.0.5 (Updated)',
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

async function serveAppWithSeo(req, res) {
  const baseUrl = getBaseUrl(req);
  const postId = req.query.post || (req.path.startsWith('/flow/') ? req.path.replace(/^\/flow\//, '') : null);
  const indexPath = path.join(__dirname, 'index.html');

  if (!fs.existsSync(indexPath)) {
    res.status(404).send('Not found');
    return;
  }

  let html = fs.readFileSync(indexPath, 'utf-8');

  // Sync canonical and og:url with dynamic baseUrl
  if (baseUrl) {
    html = html.replace(/https:\/\/paperflow\.hs\.vc\//g, `${baseUrl}/`);
  }

  if (postId) {
    try {
      let author = 'Anonymous';
      let bodyText = '';
      let imageUrl = null;
      let category = 'other';

      if (postId.startsWith('__ainews__')) {
        const item = (aiTechNewsState.items || []).find((i) => i.id === postId);
        if (item) {
          author = item.source || 'Paper Flow AI News';
          bodyText = item.title ? `${item.title}: ${item.snippet || ''}` : item.snippet || '';
          category = 'news';
          imageUrl = item.imageUrl || null;
        }
      }

      if (!bodyText) {
        const docRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/memo-board-4d45b/databases/(default)/documents/posts/${encodeURIComponent(postId)}`,
          { headers: { 'Accept': 'application/json' } }
        );
        if (docRes.ok) {
          const docData = await docRes.json();
          if (docData && docData.fields) {
            const f = docData.fields;
            author = f.authorUsername?.stringValue || f.alias?.stringValue || 'Anonymous';
            bodyText = f.body?.stringValue || '';
            imageUrl = f.imageUrl?.stringValue || f.photoUrl?.stringValue || null;
            category = f.category?.stringValue || f.tag?.stringValue || 'other';
          }
        }
      }

      if (bodyText) {
        const cleanSnippet = bodyText.replace(/\s+/g, ' ').trim();
        const shortTitle = cleanSnippet.length > 60 ? (cleanSnippet.slice(0, 57) + '…') : cleanSnippet;
        const pageTitle = `${shortTitle} — Paper Flow`;
        const pageDesc = `Read this ${category} flow by ${author} on Paper Flow: ${cleanSnippet.slice(0, 150)}${cleanSnippet.length > 150 ? '…' : ''}`;
        const postUrl = `${baseUrl}/?post=${encodeURIComponent(postId)}`;
        const shareImg = imageUrl || `${baseUrl}/pwa-512x512.png`;

        html = html
          .replace(/<title>.*?<\/title>/i, `<title>${escapeXml(pageTitle)}</title>`)
          .replace(/<meta\s+name="description"\s+content=".*?"\s*\/?>/i, `<meta name="description" content="${escapeXml(pageDesc)}" />`)
          .replace(/<link\s+rel="canonical"\s+id="seoCanonicalLink"\s+href=".*?"\s*\/?>/i, `<link rel="canonical" id="seoCanonicalLink" href="${escapeXml(postUrl)}" />`)
          .replace(/<meta\s+property="og:title"\s+content=".*?"\s*\/?>/i, `<meta property="og:title" content="${escapeXml(pageTitle)}" />`)
          .replace(/<meta\s+property="og:description"\s+content=".*?"\s*\/?>/i, `<meta property="og:description" content="${escapeXml(pageDesc)}" />`)
          .replace(/<meta\s+property="og:url"\s+id="seoOgUrl"\s+content=".*?"\s*\/?>/i, `<meta property="og:url" id="seoOgUrl" content="${escapeXml(postUrl)}" />`)
          .replace(/<meta\s+property="og:image"\s+id="seoOgImage"\s+content=".*?"\s*\/?>/i, `<meta property="og:image" id="seoOgImage" content="${escapeXml(shareImg)}" />`)
          .replace(/<meta\s+name="twitter:title"\s+content=".*?"\s*\/?>/i, `<meta name="twitter:title" content="${escapeXml(pageTitle)}" />`)
          .replace(/<meta\s+name="twitter:description"\s+content=".*?"\s*\/?>/i, `<meta name="twitter:description" content="${escapeXml(pageDesc)}" />`)
          .replace(/<meta\s+name="twitter:image"\s+id="seoTwitterImage"\s+content=".*?"\s*\/?>/i, `<meta name="twitter:image" id="seoTwitterImage" content="${escapeXml(shareImg)}" />`);
      }
    } catch (e) {
      console.error('Error in post SEO rendering:', e);
    }
  }

  res.type('text/html').send(html);
}

app.get('/', (req, res) => {
  serveAppWithSeo(req, res);
});

app.get('/index.html', (req, res) => {
  serveAppWithSeo(req, res);
});

app.get('/flow/:id', (req, res) => {
  serveAppWithSeo(req, res);
});

app.use(express.static(__dirname, { index: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((req, res) => {
  serveAppWithSeo(req, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

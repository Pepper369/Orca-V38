import { getDashboardData, type Commodity, type DashboardData, type MarketIndex, type NewsItem } from "@/lib/dashboard-data";

const VN_TZ = "Asia/Ho_Chi_Minh";
const SCAN_COOLDOWN_MS = Number(process.env.MIN_UPDATE_INTERVAL_MINUTES ?? "50") * 60_000;

export type UpdateTrigger = "cron" | "on-demand" | "manual";
export type UpdateResult = {
  ok: boolean;
  skipped: boolean;
  trigger: UpdateTrigger;
  quoteCount: number;
  newsCount: number;
  message: string;
  hasNewSnapshot: boolean;
  data: DashboardData;
};

// ────────────────────────────────────────
// In-memory cache — works WITHOUT database
// ────────────────────────────────────────
const cache = globalThis as typeof globalThis & {
  __orcaData?: DashboardData;
  __orcaUpdatedAt?: number;
};

type Quote = {
  symbol: string;
  price: number;
  previousClose?: number;
  change?: number;
  changePct?: number;
  asOf: string;
};

// ── Time helpers ──
function vnParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: VN_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  return Object.fromEntries(p.map((x) => [x.type, x.value]));
}

export function getVietnamDateShort(d = new Date()) {
  const p = vnParts(d);
  return `${p.day}/${p.month}/${p.year}`;
}

export function getVietnamDateKey(d = new Date()) {
  const p = vnParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

export function getVietnamReportDate(d = new Date()) {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: VN_TZ, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function getVietnamTimestamp(d = new Date()) {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: VN_TZ, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

// ── Fetch helpers ──
async function fetchJson<T>(url: string, ms = 8000): Promise<T | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": "ORCA/1.0", accept: "application/json,*/*" }, cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; } finally { clearTimeout(t); }
}

async function fetchText(url: string, ms = 8000): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": "ORCA/1.0", accept: "application/rss+xml,text/xml,*/*" }, cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(t); }
}

// ── Yahoo Finance ──
async function yahoo(sym: string): Promise<Quote | null> {
  type R = { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number; regularMarketTime?: number }; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
  const j = await fetchJson<R>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice) return null;
  const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((v): v is number => typeof v === "number") ?? [];
  const prev = m.chartPreviousClose ?? m.previousClose ?? closes.at(-2);
  const price = m.regularMarketPrice;
  const change = prev ? price - prev : undefined;
  const changePct = prev && change !== undefined ? (change / prev) * 100 : undefined;
  return { symbol: sym, price, previousClose: prev, change, changePct, asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : new Date().toISOString() };
}

// ── Google News RSS ──
function decXml(s: string) {
  return s.replaceAll("<![CDATA[", "").replaceAll("]]>", "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function rssNews(query: string, cat: "global" | "vietnam", limit = 2): Promise<NewsItem[]> {
  const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=vi&gl=VN&ceid=VN:vi`);
  if (!xml) return [];
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((m) => {
    const b = m[1];
    const title = decXml(b.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "Tin mới");
    const source = decXml(b.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "Google News");
    const pubDate = decXml(b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? getVietnamTimestamp());
    const impact = /CPI|Fed|VN-Index|Nasdaq|Dow|dầu|vàng|tỷ giá/i.test(title) ? "high" as const : "medium" as const;
    return { headline: title, source: `RSS / ${source}`, time: pubDate, summary: `Tự động quét: "${query}"`, impact, riskLevel: impact === "high" ? "Cao" : "TB", sectors: cat === "vietnam" ? ["VN"] : ["Global"], verified: true };
  });
}

// ── Apply quotes ──
function applyMkt(list: MarketIndex[], name: string, q: Quote | null): MarketIndex[] {
  if (!q || q.change === undefined || q.changePct === undefined) return list;
  const ch = q.change, cp = q.changePct;
  const trend: MarketIndex["trend"] = cp > 0.3 ? "bullish" : cp < -0.3 ? "bearish" : "neutral";
  return list.map((i) => i.name === name ? { ...i, value: +q.price.toFixed(2), dailyChange: +ch.toFixed(2), dailyChangePct: +cp.toFixed(2), trend } : i);
}

function applyCom(list: Commodity[], name: string, q: Quote | null, src: string): Commodity[] {
  if (!q || q.changePct === undefined) return list;
  const cp = q.changePct;
  const wt: Commodity["weeklyTrend"] = cp > 0 ? "up" : cp < 0 ? "down" : "flat";
  return list.map((i) => i.name === name ? { ...i, price: +q.price.toFixed(2), dailyChange: +cp.toFixed(2), weeklyTrend: wt, source: src, asOf: getVietnamDateShort() } : i);
}

// ── Core: build fresh data by scanning public APIs ──
async function scanFreshData(trigger: UpdateTrigger): Promise<{ data: DashboardData; quoteCount: number; newsCount: number }> {
  let data: DashboardData = JSON.parse(JSON.stringify(getDashboardData()));
  const now = new Date();
  data.date = getVietnamReportDate(now);
  data.dateShort = getVietnamDateShort(now);
  data.timestamp = `Real-time scan | ${getVietnamTimestamp(now)} | ${trigger}`;

  const quotes = await Promise.all([
    yahoo("^GSPC"), yahoo("^IXIC"), yahoo("^DJI"), yahoo("^RUT"), yahoo("^VNINDEX.VN"),
    yahoo("BZ=F"), yahoo("CL=F"), yahoo("GC=F"), yahoo("SI=F"), yahoo("BTC-USD"),
  ]);
  const [spx, nas, dow, rut, vni, brent, wti, gold, silver] = quotes;
  const quoteCount = quotes.filter(Boolean).length;

  data.globalMarkets = applyMkt(data.globalMarkets, "S&P 500", spx);
  data.globalMarkets = applyMkt(data.globalMarkets, "NASDAQ", nas);
  data.globalMarkets = applyMkt(data.globalMarkets, "DOW JONES", dow);
  data.globalMarkets = applyMkt(data.globalMarkets, "Russell 2000", rut);
  data.vietnamMarkets = applyMkt(data.vietnamMarkets, "VNINDEX", vni);
  data.commodities = applyCom(data.commodities, "Dầu Brent", brent, "Yahoo Finance");
  data.commodities = applyCom(data.commodities, "Dầu WTI", wti, "Yahoo Finance");
  data.commodities = applyCom(data.commodities, "Vàng spot", gold, "Yahoo Finance");
  data.commodities = applyCom(data.commodities, "Bạc", silver, "Yahoo Finance");

  const [gn, vn, mn] = await Promise.all([
    rssNews("S&P 500 Nasdaq Fed CPI market today", "global", 2),
    rssNews("VN-Index chứng khoán Việt Nam hôm nay", "vietnam", 2),
    rssNews("Brent oil gold treasury yield today", "global", 1),
  ]);
  const newsCount = gn.length + vn.length + mn.length;
  if (gn.length || mn.length) data.globalNews = [...gn, ...mn, ...data.globalNews].slice(0, 12);
  if (vn.length) data.vietnamNews = [...vn, ...data.vietnamNews].slice(0, 10);

  data.confidenceScores = {
    ...data.confidenceScores,
    dataReliability: Math.max(data.confidenceScores.dataReliability, quoteCount >= 6 ? 92 : 86),
    explanation: `Quét ${quoteCount} quotes + ${newsCount} tin RSS lúc ${getVietnamTimestamp(now)}. ${data.confidenceScores.explanation}`,
  };

  return { data, quoteCount, newsCount };
}

// ── Try save to DB (best-effort, skip if no DB) ──
async function trySaveToDb(data: DashboardData, quoteCount: number, newsCount: number) {
  try {
    const { getDb } = await import("@/db");
    const { dashboardSnapshots, marketAlerts } = await import("@/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb();

    await db.execute(sql`create table if not exists dashboard_snapshots (id serial primary key, snapshot_date date not null default current_date, data jsonb not null, created_at timestamp not null default now())`);
    await db.execute(sql`create table if not exists market_alerts (id serial primary key, alert_type text not null, title text not null, message text not null, severity text not null, created_at timestamp not null default now())`);

    await db.insert(dashboardSnapshots).values({ snapshotDate: getVietnamDateKey(), data });
    await db.insert(marketAlerts).values({ alertType: "hourly_scan", title: `ORCA scan ${getVietnamTimestamp()}`, message: `${quoteCount} quotes, ${newsCount} news`, severity: "info" });
    await db.execute(sql`delete from dashboard_snapshots where created_at < now() - interval '45 days'`);
    await db.execute(sql`delete from market_alerts where created_at < now() - interval '45 days'`);
  } catch {
    // No database available — that's fine, memory cache still works
  }
}

// ── Public API ──

function isCacheFresh() {
  return cache.__orcaData && cache.__orcaUpdatedAt && (Date.now() - cache.__orcaUpdatedAt < SCAN_COOLDOWN_MS);
}

export async function runMarketUpdate({ force = false, trigger = "cron" }: { force?: boolean; trigger?: UpdateTrigger } = {}): Promise<UpdateResult> {
  if (!force && isCacheFresh()) {
    return { ok: true, skipped: true, trigger, quoteCount: 0, newsCount: 0, message: "Cache còn mới, bỏ qua scan.", hasNewSnapshot: false, data: cache.__orcaData! };
  }

  const { data, quoteCount, newsCount } = await scanFreshData(trigger);

  // Save to memory cache (always works)
  cache.__orcaData = data;
  cache.__orcaUpdatedAt = Date.now();

  // Try save to DB (best-effort)
  await trySaveToDb(data, quoteCount, newsCount);

  return { ok: true, skipped: false, trigger, quoteCount, newsCount, message: `Đã quét ${quoteCount} quotes + ${newsCount} tin.`, hasNewSnapshot: true, data };
}

export async function getLatestDashboardData(): Promise<DashboardData> {
  // 1. Memory cache
  if (cache.__orcaData) return cache.__orcaData;

  // 2. Try DB
  try {
    const { getDb } = await import("@/db");
    const { dashboardSnapshots } = await import("@/db/schema");
    const { desc } = await import("drizzle-orm");
    const db = getDb();
    const rows = await db.select().from(dashboardSnapshots).orderBy(desc(dashboardSnapshots.createdAt)).limit(1);
    if (rows[0]?.data) {
      const d = rows[0].data as DashboardData;
      cache.__orcaData = d;
      cache.__orcaUpdatedAt = rows[0].createdAt ? new Date(rows[0].createdAt).getTime() : 0;
      return d;
    }
  } catch {
    // No DB — fall through
  }

  // 3. Bundled fallback
  return getDashboardData();
}

export async function maybeRunDueUpdate(): Promise<UpdateResult | null> {
  if (isCacheFresh()) return null;
  return runMarketUpdate({ trigger: "on-demand" });
}

export async function runDailyTask(): Promise<UpdateResult> {
  return runMarketUpdate({ force: true, trigger: "manual" });
}

// Backward compat
export type DailyUpdateResult = UpdateResult;
export async function runDailyMarketUpdate(opts?: { force?: boolean; trigger?: UpdateTrigger }) { return runMarketUpdate(opts); }
export function getHourlyUpdateIntervalMinutes() { return 60; }

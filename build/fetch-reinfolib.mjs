#!/usr/bin/env node
/**
 * 取引価格データ取得 ETL（フェーズ2）
 *
 *   node build/fetch-reinfolib.mjs [--year 2024] [--quarter all|1|2|3|4] [--concurrency 3]
 *
 * 動作：
 *   - data/cities.json の各主要都市について、Worker 経由で reinfolib XIT001 を呼ぶ
 *   - 政令市（is_seirei）は wards に展開して並列 fetch
 *   - 取引データを集計し data/transactions-stats.json を生成
 *   - その後 build/generate-areas.mjs を実行すれば各ページに数値が埋め込まれる
 *
 * 依存：Node.js 18 以降（標準 fetch）
 *
 * 注意：
 *   - Worker は CORS *、認証なし、24h エッジキャッシュあり
 *   - 連続実行で Cloudflare Free 100k req/day を超えないよう concurrency を抑える
 *   - reinfolib API キーは Worker 側 secret（このスクリプトには不要）
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const WORKER = "https://fudosan-map.furusawa66.workers.dev";
const KEEP_RECORDS_PER_AREA = 500; // 各エリア保持する直近件数

/* ---------- args ---------- */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const YEARS = String(args.years || args.year || (new Date().getFullYear() - 1))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((y) => Number.isFinite(y));
const QUARTERS = args.quarter && args.quarter !== "all"
  ? [Number(args.quarter)]
  : [1, 2, 3, 4];
const CONCURRENCY = Number(args.concurrency || 3);

const cities = JSON.parse(readFileSync(join(ROOT, "data/cities.json"), "utf-8"));

/* ---------- worker call ---------- */

async function fetchOne({ pref, city, year, quarter }) {
  const u = `${WORKER}/?year=${year}&quarter=${quarter}&prefecture=${pref}&city=${city}&language=ja`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${pref}/${city} ${year}Q${quarter}`);
  const json = await r.json();
  return Array.isArray(json.data) ? json.data : [];
}

/* ---------- pool ---------- */

async function pool(items, fn, concurrency) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        console.warn(`  ! ${items[idx].city} ${items[idx].year}Q${items[idx].quarter}: ${e.message}`);
        results[idx] = [];
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------- stats ---------- */

function toPriceNumbers(records) {
  const arr = [];
  for (const r of records) {
    const p = Number(r.TradePrice);
    if (!Number.isFinite(p) || p <= 0) continue;
    arr.push(p);
  }
  return arr;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function summarize(prices, period) {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  return {
    period,
    count: sorted.length,
    low: Math.round(percentile(sorted, 0.10)),
    high: Math.round(percentile(sorted, 0.90)),
    median: Math.round(percentile(sorted, 0.50)),
  };
}

// "2024年第3四半期" → 20243 （新しいほど大きい）
function periodToOrder(period) {
  if (!period) return 0;
  const m = String(period).match(/(\d+)年第([1-4])四半期/);
  if (!m) return 0;
  return Number(m[1]) * 10 + Number(m[2]);
}

// 表示用に必要なフィールドだけ残す
function trimRecord(r) {
  return {
    Period: r.Period || "",
    Type: r.Type || "",
    Region: r.Region || "",
    Municipality: r.Municipality || "",
    DistrictName: r.DistrictName || "",
    TradePrice: r.TradePrice || "",
    Area: r.Area || "",
    BuildingYear: r.BuildingYear || "",
    Structure: r.Structure || "",
    Use: r.Use || "",
    FloorPlan: r.FloorPlan || "",
  };
}

/* ---------- run ---------- */

(async () => {
  const period = YEARS.length === 1
    ? `${YEARS[0]}年 Q${QUARTERS.join("・Q")}`
    : `${YEARS[0]}年〜${YEARS[YEARS.length - 1]}年`;
  console.log(`Period: ${period}`);
  console.log(`Years: ${YEARS.join(", ")}  Quarters: ${QUARTERS.join(", ")}`);
  console.log(`Worker: ${WORKER}`);
  console.log(`Cities: ${cities.length} / Concurrency: ${CONCURRENCY}`);

  const stats = {};
  const prefBuckets = new Map(); // pref_code -> [prices...]
  const prefRecords = new Map(); // pref_code -> [records...]

  mkdirSync(join(ROOT, "data/transactions"), { recursive: true });

  const fetchedAt = new Date().toISOString();

  for (const c of cities) {
    const wardCodes = (c.wards || c.code).split(",");
    const tasks = [];
    for (const ward of wardCodes) {
      for (const y of YEARS) {
        for (const q of QUARTERS) {
          tasks.push({ pref: c.pref_code, city: ward, year: y, quarter: q });
        }
      }
    }
    console.log(`\n${c.name} (${c.code}) — ${tasks.length} requests`);
    const allRecords = (await pool(tasks, fetchOne, CONCURRENCY)).flat();
    const prices = toPriceNumbers(allRecords);

    const summary = summarize(prices, period);
    if (summary) {
      stats[`city:${c.code}`] = summary;
      console.log(`  ${c.name}: ${summary.count} records, median ${summary.median.toLocaleString()}`);
    } else {
      console.log(`  ${c.name}: no data`);
    }

    // 直近順に並べて上位 KEEP_RECORDS_PER_AREA 件だけ保持
    const sortedRec = [...allRecords].sort(
      (a, b) => periodToOrder(b.Period) - periodToOrder(a.Period)
    );
    const kept = sortedRec.slice(0, KEEP_RECORDS_PER_AREA).map(trimRecord);
    const cityFile = {
      key: `city:${c.code}`,
      name: c.name,
      pref_code: c.pref_code,
      period,
      fetched_at: fetchedAt,
      total: allRecords.length,
      kept: kept.length,
      records: kept,
    };
    writeFileSync(
      join(ROOT, `data/transactions/city-${c.code}.json`),
      JSON.stringify(cityFile, null, 2)
    );

    // pref-level aggregation
    const pb = prefBuckets.get(c.pref_code) || [];
    pb.push(...prices);
    prefBuckets.set(c.pref_code, pb);

    const pr = prefRecords.get(c.pref_code) || [];
    pr.push(...sortedRec);
    prefRecords.set(c.pref_code, pr);
  }

  // pref-level
  for (const [prefCode, prices] of prefBuckets) {
    const s = summarize(prices, period);
    if (s) stats[`pref:${prefCode}`] = s;
  }
  for (const [prefCode, records] of prefRecords) {
    const sorted = [...records].sort(
      (a, b) => periodToOrder(b.Period) - periodToOrder(a.Period)
    );
    const kept = sorted.slice(0, KEEP_RECORDS_PER_AREA).map(trimRecord);
    const prefFile = {
      key: `pref:${prefCode}`,
      pref_code: prefCode,
      period,
      fetched_at: fetchedAt,
      total: records.length,
      kept: kept.length,
      records: kept,
    };
    writeFileSync(
      join(ROOT, `data/transactions/pref-${prefCode}.json`),
      JSON.stringify(prefFile, null, 2)
    );
  }

  const outPath = join(ROOT, "data/transactions-stats.json");
  writeFileSync(outPath, JSON.stringify(stats, null, 2));
  console.log(`\nWrote ${Object.keys(stats).length} stats entries to ${outPath}`);
  console.log(`Wrote per-area record files (top ${KEEP_RECORDS_PER_AREA}) to data/transactions/`);
  console.log("Next: node build/generate-areas.mjs && commit & push");
})();

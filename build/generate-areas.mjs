#!/usr/bin/env node
/**
 * 地域別ページ生成スクリプト（フェーズ1：プレースホルダ）
 *
 *   node build/generate-areas.mjs
 *
 * 生成先：
 *   areas/<pref-slug>/index.html        （47都道府県）
 *   areas/city/<city-slug>/index.html   （主要13都市）
 *
 * フェーズ2でAPI取得結果をデータJSONに差し込み、本スクリプトを再実行する。
 * いまは noindex,follow で出力する（実データ未差し込みのため）。
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const regions = JSON.parse(readFileSync(join(ROOT, "data/regions.json"), "utf-8"));
const prefs = JSON.parse(readFileSync(join(ROOT, "data/prefectures.json"), "utf-8"));
const cities = JSON.parse(readFileSync(join(ROOT, "data/cities.json"), "utf-8"));

// 取引データJSON（フェーズ2で生成）。無ければ空でフォールバック。
let txStats = {};
try {
  txStats = JSON.parse(readFileSync(join(ROOT, "data/transactions-stats.json"), "utf-8"));
} catch { /* phase 1: no data yet */ }

const SITE = "https://jikka-uru.jp";
const TODAY = new Date().toISOString().slice(0, 10);

/* ---------- helpers ---------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const formatYen = (v) => {
  if (!Number.isFinite(v)) return "―";
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}億円`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}万円`;
  return `${Math.round(v).toLocaleString()}円`;
};

const formatRange = (low, high) => `約 ${formatYen(low)} 〜 ${formatYen(high)}`;

const writePage = (relPath, html) => {
  const full = join(ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html, "utf-8");
};

/* ---------- shared chrome ---------- */

const head = ({ title, description, canonical, ogType = "article" }) => `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="noindex,follow" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta property="og:type" content="${ogType}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" href="/favicon.svg" />
  <meta name="theme-color" content="#2d6a5c" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="site-header">
    <div class="container site-header__inner">
      <a class="brand" href="/" aria-label="相続した実家の売却目安診断 トップへ">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__text">相続実家 診断</span>
      </a>
      <nav class="site-nav" aria-label="主要メニュー">
        <a href="/#diagnose">診断する</a>
        <a href="/#areas">地域から探す</a>
        <a href="/#about">このツールについて</a>
      </nav>
    </div>
  </header>
  <main>`;

const footer = `  </main>
  <footer class="site-footer">
    <div class="container">
      <p class="site-footer__note">本サイトの数値は参考値であり、売却額・賃料・税金・費用を保証するものではありません。最終判断の前に、不動産会社・税理士・司法書士など専門家への確認をお願いします。</p>
      <nav class="site-footer__nav" aria-label="フッターメニュー">
        <a href="/sitemap.html">サイトマップ</a>
        <span class="site-footer__sep" aria-hidden="true">・</span>
        <a href="/privacy.html">プライバシーポリシー</a>
      </nav>
      <p class="site-footer__copy">© 相続実家 売却目安診断</p>
    </div>
  </footer>
</body>
</html>
`;

const breadcrumb = (items) => {
  const list = items.map((x, i) =>
    `<li${i === items.length - 1 ? ' aria-current="page"' : ""}>${
      x.href ? `<a href="${esc(x.href)}">${esc(x.label)}</a>` : esc(x.label)
    }</li>`
  ).join("");
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((x, i) => ({
      "@type": "ListItem", position: i + 1, name: x.label,
      ...(x.href ? { item: x.href.startsWith("http") ? x.href : SITE + x.href } : {}),
    })),
  };
  return `<nav class="breadcrumb" aria-label="パンくず"><ol>${list}</ol></nav>
<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
};

const ctaBlock = `<section class="card cta-block area-cta">
  <p class="cta-block__lead">相続した実家の売却・貸す・解体・放置の判断材料を、簡易診断で確認できます。</p>
  <a href="/#diagnose" class="btn btn--cta">診断ツールを使う</a>
  <p class="cta-block__note">入力1分。数値は参考値であり査定額ではありません。</p>
</section>`;

const apiCredit = `<p class="api-credit">出典：このサービスは国土交通省 不動産情報ライブラリのAPI機能を使用していますが、提供情報の最新性、正確性、完全性等が保証されたものではありません。</p>`;

const dataPlaceholder = `<section class="card data-placeholder">
  <h2>近隣取引から見た参考相場</h2>
  <p class="muted">このエリアの取引価格・地価・空き家率などの実データは現在準備中です。</p>
  <p class="muted">公開時には、国土交通省 不動産情報ライブラリの取引価格情報・地価公示／地価調査、住宅・土地統計調査による空き家率、将来推計人口の参考値を掲載予定です。</p>
</section>`;

/* ---------- prefecture page ---------- */

function renderPref(pref) {
  const region = regions[pref.region];
  const sameRegion = prefs.filter((p) => p.region === pref.region && p.code !== pref.code);
  const cityList = cities.filter((c) => c.pref_code === pref.code);
  const stats = txStats[`pref:${pref.code}`];

  const title = `${pref.name}の相続した実家・空き家 売却参考相場｜売却目安診断`;
  const description = `${pref.name}で相続した実家・空き家の売却を検討中の方向け。近隣取引から見た参考価格、解体費、貸す現実度、放置リスクを診断ツールで確認できます。`;
  const canonical = `${SITE}/areas/${pref.slug}/`;

  const statsBlock = stats
    ? `<section class="card stats-card">
  <h2>近隣取引から見た参考相場</h2>
  <p class="stats-meta">対象期間：${esc(stats.period)}／集計件数：${stats.count.toLocaleString()}件</p>
  <p class="stats-value">${formatRange(stats.low, stats.high)}</p>
  <p class="stats-sub">中央値：${formatYen(stats.median)}（参考）</p>
  <p class="muted">数値は集計上の参考値であり、査定額・成約額を保証するものではありません。</p>
  ${apiCredit}
</section>`
    : dataPlaceholder;

  const cityListBlock = cityList.length
    ? `<section class="card area-children">
  <h2>${esc(pref.name)}の主要エリア</h2>
  <ul class="area-links">
    ${cityList.map((c) => `<li><a href="/areas/city/${esc(c.slug)}/">${esc(c.name)}</a></li>`).join("\n    ")}
  </ul>
</section>`
    : "";

  const sameRegionBlock = sameRegion.length
    ? `<section class="card area-siblings">
  <h2>${esc(region.name)}の他のエリア</h2>
  <ul class="area-links">
    ${sameRegion.map((p) => `<li><a href="/areas/${esc(p.slug)}/">${esc(p.name)}</a></li>`).join("\n    ")}
  </ul>
</section>`
    : "";

  return head({ title, description, canonical }) + `
    <section class="subpage area-page">
      <div class="container">
        ${breadcrumb([
          { label: "トップ", href: "/" },
          { label: "地域別", href: "/#areas" },
          { label: pref.name },
        ])}
        <div class="card">
          <p class="eyebrow">${esc(region.name)}地方</p>
          <h1>${esc(pref.name)}の相続した実家・空き家 売却参考相場</h1>
          <p class="subpage__lead">${esc(pref.name)}で相続した実家・空き家を「売る・貸す・解体・放置」のどれにすべきか迷っている方に向けて、判断材料を整理するページです。</p>
          <p>${esc(region.description)}</p>
          <p class="muted">最終的な売却価格・賃料・解体費は、立地・建物状態・接道条件などで変動します。本ページの数値は集計上の参考値であり、査定額ではありません。</p>
        </div>

        ${statsBlock}

        ${ctaBlock}

        ${cityListBlock}

        ${sameRegionBlock}
      </div>
    </section>
` + footer;
}

/* ---------- city page ---------- */

function renderCity(city) {
  const pref = prefs.find((p) => p.code === city.pref_code);
  const region = regions[pref.region];
  const sameCities = cities.filter((c) => c.pref_code === city.pref_code && c.code !== city.code);
  const stats = txStats[`city:${city.code}`];

  const title = `${city.name}の相続した実家・空き家 売却参考相場｜売却目安診断`;
  const description = `${city.name}（${pref.name}）で相続した実家・空き家の売却を検討中の方向け。近隣取引から見た参考価格、解体費、貸す現実度、放置リスクを診断ツールで確認できます。`;
  const canonical = `${SITE}/areas/city/${city.slug}/`;

  const statsBlock = stats
    ? `<section class="card stats-card">
  <h2>近隣取引から見た参考相場</h2>
  <p class="stats-meta">対象期間：${esc(stats.period)}／集計件数：${stats.count.toLocaleString()}件</p>
  <p class="stats-value">${formatRange(stats.low, stats.high)}</p>
  <p class="stats-sub">中央値：${formatYen(stats.median)}（参考）</p>
  <p class="muted">数値は集計上の参考値であり、査定額・成約額を保証するものではありません。</p>
  ${apiCredit}
</section>`
    : dataPlaceholder;

  const siblingBlock = sameCities.length
    ? `<section class="card area-siblings">
  <h2>${esc(pref.name)}の他の主要エリア</h2>
  <ul class="area-links">
    ${sameCities.map((c) => `<li><a href="/areas/city/${esc(c.slug)}/">${esc(c.name)}</a></li>`).join("\n    ")}
  </ul>
</section>`
    : "";

  return head({ title, description, canonical }) + `
    <section class="subpage area-page">
      <div class="container">
        ${breadcrumb([
          { label: "トップ", href: "/" },
          { label: "地域別", href: "/#areas" },
          { label: pref.name, href: `/areas/${pref.slug}/` },
          { label: city.name },
        ])}
        <div class="card">
          <p class="eyebrow">${esc(pref.name)}・${esc(region.name)}地方</p>
          <h1>${esc(city.name)}の相続した実家・空き家 売却参考相場</h1>
          <p class="subpage__lead">${esc(city.name)}で相続した実家・空き家を「売る・貸す・解体・放置」のどれにすべきか迷っている方に向けて、判断材料を整理するページです。</p>
          <p>${esc(region.description)}</p>
          <p class="muted">${esc(city.name)}内でも区・町ごとに需要や相場は異なります。最終的な金額は不動産会社の現地査定で確認が必要です。</p>
        </div>

        ${statsBlock}

        ${ctaBlock}

        ${siblingBlock}

        <section class="card area-parent">
          <h2>${esc(pref.name)}全体を見る</h2>
          <p><a href="/areas/${pref.slug}/">${esc(pref.name)}の参考相場ページへ</a></p>
        </section>
      </div>
    </section>
` + footer;
}

/* ---------- run ---------- */

let prefCount = 0, cityCount = 0;

for (const pref of prefs) {
  writePage(`areas/${pref.slug}/index.html`, renderPref(pref));
  prefCount++;
}
for (const city of cities) {
  writePage(`areas/city/${city.slug}/index.html`, renderCity(city));
  cityCount++;
}

console.log(`Generated ${prefCount} prefecture pages and ${cityCount} city pages.`);
console.log(`Generated at: ${TODAY}`);

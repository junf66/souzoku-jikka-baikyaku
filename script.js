/**
 * 相続した実家 売却目安診断 - 計算・UIロジック
 *
 * MVPでは仮単価・固定係数で算出する。
 * 将来は dataSources を国交省 不動産情報ライブラリ（取引価格・成約価格）、
 * 地価公示・地価調査、住宅・土地統計調査、市区町村別空き家率、
 * 将来推計人口などに差し替えられる構造としている。
 */

/* ============================================================
 * データソース（将来差し替えポイント）
 * ============================================================ */

// 地域別 仮土地単価（円/㎡）
// → 将来: 国交省 不動産情報ライブラリの取引価格データ＋地価公示の市区町村別中央値に差し替え
const landUnitPriceJpy = {
  urban: 340000,
  suburban: 150000,
  rural: 60000,
};

// 木造住宅 解体費の坪単価レンジ（円/坪）
// → 将来: 地域・進入路・延床区分別の事業者見積りデータに差し替え
const demolitionPerTsuboJpy = { min: 40000, max: 62000 };

// 1坪 ≒ 3.305785 ㎡
const TSUBO = 3.305785;

/* ============================================================
 * 入力 → 数値化
 * ============================================================ */

function parseInputs(form) {
  const fd = new FormData(form);
  return {
    locationType: fd.get("locationType"),
    landArea: Number(fd.get("landArea")),
    floorArea: Number(fd.get("floorArea")),
    buildingAge: Number(fd.get("buildingAge")),
    condition: fd.get("condition"),
    road: fd.get("road"),
  };
}

function validate(input) {
  const errors = [];
  if (!input.locationType) errors.push("所在地タイプ");
  if (!Number.isFinite(input.landArea) || input.landArea <= 0) errors.push("土地面積");
  if (!Number.isFinite(input.floorArea) || input.floorArea <= 0) errors.push("延床面積");
  if (!Number.isFinite(input.buildingAge) || input.buildingAge < 0) errors.push("築年数");
  if (!input.condition) errors.push("建物の状態");
  if (!input.road) errors.push("接道・再建築");
  return errors;
}

/* ============================================================
 * 売却参考価格
 *   土地評価 × 補正（築年・状態・接道） + 建物簡易評価
 *   結果はレンジで返す
 * ============================================================ */

function buildingSimpleValueJpy(input) {
  // 居住可能で築浅なら建物価値を加算、それ以外はほぼゼロ評価
  if (input.condition === "livable" && input.buildingAge < 20) {
    return input.floorArea * 100000;
  }
  if (input.condition === "livable" && input.buildingAge < 30) {
    return input.floorArea * 40000;
  }
  if (input.condition === "repair" && input.buildingAge < 20) {
    return input.floorArea * 30000;
  }
  return 0;
}

function ageMultiplier(age) {
  if (age < 30) return 1.0;
  if (age < 50) return 0.95;
  return 0.9;
}

function conditionSaleMultiplier(condition) {
  switch (condition) {
    case "livable": return 1.0;
    case "repair": return 0.92;
    case "damaged": return 0.85;
    case "unknown": return 0.9;
    default: return 0.95;
  }
}

function roadSaleMultiplier(road) {
  switch (road) {
    case "ok": return 1.0;
    case "narrow": return 0.9;
    case "nonrebuild": return 0.65;
    case "unknown": return 0.92;
    default: return 0.95;
  }
}

function calcSaleEstimate(input) {
  const land = input.landArea * landUnitPriceJpy[input.locationType];
  const building = buildingSimpleValueJpy(input);
  const base = (land + building)
    * ageMultiplier(input.buildingAge)
    * conditionSaleMultiplier(input.condition)
    * roadSaleMultiplier(input.road);

  const low = Math.round(base * 0.85);
  const high = Math.round(base * 1.10);
  return { low, high, mid: Math.round(base) };
}

/* ============================================================
 * 売却向き判定（高い／中程度／慎重に検討）
 * ============================================================ */

function calcSellFit(input) {
  let score = 50;
  if (input.locationType === "urban") score += 25;
  else if (input.locationType === "suburban") score += 8;
  else score -= 8;

  if (input.road === "ok") score += 8;
  else if (input.road === "narrow") score -= 8;
  else if (input.road === "nonrebuild") score -= 25;
  else score -= 5;

  // 築古でも土地として売却しやすいことが多いので過度な減点は避ける
  if (input.condition === "damaged") score -= 5;
  if (input.condition === "unknown") score -= 3;

  if (input.landArea < 50) score -= 10;

  let label;
  if (score >= 70) label = "売却しやすい可能性が高い";
  else if (score >= 50) label = "売却の検討余地あり";
  else label = "売却条件は慎重な確認が必要";

  return { score: clamp(score, 0, 100), label };
}

/* ============================================================
 * 貸す現実度（スコア表示。賃料は出さない）
 * ============================================================ */

function calcRentScore(input) {
  let score = 50;

  if (input.locationType === "urban") score += 25;
  else if (input.locationType === "suburban") score += 5;
  else score -= 15;

  if (input.condition === "livable") score += 18;
  else if (input.condition === "repair") score -= 12;
  else if (input.condition === "damaged") score -= 28;
  else score -= 10;

  if (input.buildingAge < 20) score += 8;
  else if (input.buildingAge < 40) score += 0;
  else score -= 12;

  if (input.road === "ok") score += 5;
  else if (input.road === "narrow") score -= 8;
  else if (input.road === "nonrebuild") score -= 15;
  else score -= 4;

  score = clamp(score, 0, 100);

  let label;
  if (score >= 70) label = "貸せる可能性あり（要修繕費試算）";
  else if (score >= 45) label = "貸す難易度はやや高め";
  else label = "貸すのは難しい可能性が高い";

  return { score, label };
}

/* ============================================================
 * 解体費（坪単価ベース、上振れ補正あり）
 * ============================================================ */

function calcDemolitionCost(input) {
  const tsubo = input.floorArea / TSUBO;
  let lowUnit = demolitionPerTsuboJpy.min;
  let highUnit = demolitionPerTsuboJpy.max;

  let upMul = 1.0;
  if (input.condition === "damaged") upMul *= 1.20;
  if (input.condition === "unknown") upMul *= 1.10;
  if (input.road === "narrow") upMul *= 1.15;
  if (input.road === "nonrebuild") upMul *= 1.10;
  if (input.road === "unknown") upMul *= 1.05;

  const low = Math.round(tsubo * lowUnit * upMul);
  const high = Math.round(tsubo * highUnit * upMul);
  return { low, high, tsubo: Math.round(tsubo * 10) / 10 };
}

/* ============================================================
 * 放置リスク注意項目
 * ============================================================ */

function leaveRisks(input) {
  const items = [
    "固定資産税・都市計画税は所有している限り毎年発生します",
    "火災保険・地震保険の継続費用が必要になります",
    "草木の繁茂・雪害など、近隣トラブルにつながる管理対応が必要です",
  ];
  if (input.condition === "damaged" || input.condition === "unknown") {
    items.push("劣化が進むと「管理不全空家」「特定空家」に指定され、固定資産税の住宅用地特例が外れる可能性があります");
  } else {
    items.push("管理不全空家・特定空家の指定リスクがあり、指定されると固定資産税の住宅用地特例が外れる可能性があります");
  }
  if (input.locationType !== "urban") {
    items.push("地方・郊外では時間経過とともに売却価格が下振れする可能性があります");
  }
  return items;
}

/* ============================================================
 * 判断材料（タブ用）
 * ============================================================ */

function buildReasons(input, sale, sellFit, rent, demo) {
  const locLabel = { urban: "都市部", suburban: "郊外", rural: "地方" }[input.locationType];
  const conLabel = { livable: "住める", repair: "修繕必要", damaged: "かなり傷んでいる", unknown: "不明" }[input.condition];
  const roadLabel = { ok: "問題なさそう", narrow: "道路が狭い", nonrebuild: "再建築不可の可能性", unknown: "不明" }[input.road];

  const sale_ = [
    `所在地タイプ：${locLabel}（仮土地単価 ${formatYen(landUnitPriceJpy[input.locationType])}/㎡を参照）`,
    `築${input.buildingAge}年・建物状態「${conLabel}」を加味し、補正後の参考価格を算出`,
    `接道条件「${roadLabel}」は売却価格に影響する可能性あり`,
    sellFit.label,
  ];
  if (input.road === "nonrebuild") {
    sale_.push("再建築不可の可能性がある場合、市場価格は大きく下振れする可能性があります");
  }

  const rent_ = [
    `${locLabel}・建物状態「${conLabel}」・築${input.buildingAge}年でのスコアは ${rent.score}/100`,
    rent.label,
    "戸建賃貸はリフォーム費用と賃料想定の比較が必要です（賃料断定はできません）",
    "賃貸管理会社・地域の戸建賃料相場の確認が必要です",
  ];

  const demo_ = [
    `延床 ${input.floorArea}㎡（約${demo.tsubo}坪）・木造住宅の概算`,
    `坪単価レンジ ${formatYen(demolitionPerTsuboJpy.min)}〜${formatYen(demolitionPerTsuboJpy.max)} を基準（地域・進入路で増減）`,
  ];
  if (input.condition === "damaged") demo_.push("かなり傷んでいるため、廃材量・分別費用が増える可能性があります");
  if (input.road === "narrow") demo_.push("道路が狭く重機進入が難しい場合、人力解体で費用が上振れする可能性があります");
  if (input.road === "nonrebuild") demo_.push("再建築不可の可能性がある土地は、解体後の活用可否に注意が必要です");
  if (input.condition === "unknown") demo_.push("アスベスト・浄化槽・残置物の有無で実費は大きく変動する可能性があります");

  const leave_ = leaveRisks(input);

  return { sale: sale_, rent: rent_, demolish: demo_, leave: leave_ };
}

/* ============================================================
 * 表示用ユーティリティ
 * ============================================================ */

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function formatYen(v) {
  if (!Number.isFinite(v)) return "―";
  if (v >= 100000000) {
    const oku = v / 100000000;
    return `${oku.toFixed(oku >= 10 ? 1 : 2)}億円`;
  }
  if (v >= 10000) {
    const man = Math.round(v / 10000);
    return `${man.toLocaleString()}万円`;
  }
  return `${Math.round(v).toLocaleString()}円`;
}

function formatYenRange(low, high) {
  return `約 ${formatYen(low)} 〜 ${formatYen(high)}`;
}

/* ============================================================
 * 結果反映
 * ============================================================ */

function renderResult(input) {
  const sale = calcSaleEstimate(input);
  const sellFit = calcSellFit(input);
  const rent = calcRentScore(input);
  const demo = calcDemolitionCost(input);
  const reasons = buildReasons(input, sale, sellFit, rent, demo);

  // 売却目安
  document.getElementById("r-sale-value").textContent = formatYenRange(sale.low, sale.high);
  document.getElementById("r-sale-sub").textContent = "近隣取引から見た参考価格レンジ（査定額ではありません）";

  // 売却向き
  document.getElementById("r-sellfit-value").textContent = sellFit.label;
  document.getElementById("r-sellfit-sub").textContent = `スコア ${sellFit.score}/100（参考）`;

  // 貸す現実度
  document.getElementById("r-rent-value").textContent = rent.label;
  document.getElementById("r-rent-sub").textContent = `スコア ${rent.score}/100（賃料断定はできません）`;
  document.getElementById("r-rent-bar").style.width = `${rent.score}%`;

  // 解体費
  document.getElementById("r-demolish-value").textContent = formatYenRange(demo.low, demo.high);
  document.getElementById("r-demolish-sub").textContent = `延床約${demo.tsubo}坪・木造住宅の概算（実費は相見積りで確認が必要）`;

  // 放置リスク
  document.getElementById("r-leave-value").textContent = "次の点に注意が必要です";
  const leaveList = document.getElementById("r-leave-list");
  leaveList.innerHTML = "";
  reasons.leave.forEach(t => {
    const li = document.createElement("li");
    li.textContent = t;
    leaveList.appendChild(li);
  });

  // タブ内 reason
  fillList("reason-sale", reasons.sale);
  fillList("reason-rent", reasons.rent);
  fillList("reason-demolish", reasons.demolish);
  fillList("reason-leave", reasons.leave);

  // 表示
  const result = document.getElementById("result");
  result.classList.remove("hidden");
  // スマホでも結果が見えるようスクロール
  result.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fillList(id, items) {
  const el = document.getElementById(id);
  el.innerHTML = "";
  items.forEach(t => {
    const li = document.createElement("li");
    li.textContent = t;
    el.appendChild(li);
  });
}

/* ============================================================
 * 初期化
 * ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("diagnose-form");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = parseInputs(form);
    const errors = validate(input);
    if (errors.length > 0) {
      alert("以下の項目を入力してください：\n・" + errors.join("\n・"));
      return;
    }
    renderResult(input);
  });

  form.addEventListener("reset", () => {
    document.getElementById("result").classList.add("hidden");
  });

  // タブ切替
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".tab-panel");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.tab;
      tabs.forEach(t => {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach(p => {
        p.classList.toggle("is-active", p.dataset.tabPanel === key);
      });
    });
  });
});

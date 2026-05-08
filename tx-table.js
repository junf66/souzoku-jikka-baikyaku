/**
 * 取引事例テーブルの並び替え（クリックで昇順／降順）
 * data-sortable のついた <th> のクリックでその列を並び替え。
 * data-value 属性があれば数値として、無ければ文字列として比較。
 */
(function () {
  function getValue(cell) {
    const v = cell.dataset.value;
    if (v !== undefined && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      return v;
    }
    return cell.textContent.trim();
  }

  function compare(a, b, dir) {
    if (typeof a === "number" && typeof b === "number") {
      return dir === "asc" ? a - b : b - a;
    }
    const aa = String(a), bb = String(b);
    return dir === "asc" ? aa.localeCompare(bb, "ja") : bb.localeCompare(aa, "ja");
  }

  function attach(table) {
    const ths = table.tHead && table.tHead.rows[0]
      ? Array.from(table.tHead.rows[0].cells)
      : [];
    ths.forEach(function (th, idx) {
      if (!th.hasAttribute("data-sortable")) return;
      th.setAttribute("role", "button");
      th.setAttribute("tabindex", "0");
      th.addEventListener("click", function () { sortBy(table, ths, idx, th); });
      th.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          sortBy(table, ths, idx, th);
        }
      });
    });
  }

  function sortBy(table, ths, colIdx, th) {
    const tbody = table.tBodies[0];
    if (!tbody) return;
    const rows = Array.from(tbody.rows);
    const cur = th.dataset.dir;
    const def = th.dataset.defaultDir || "asc";
    const dir = cur === "asc" ? "desc" : (cur === "desc" ? "asc" : def);

    rows.sort(function (ra, rb) {
      return compare(getValue(ra.cells[colIdx]), getValue(rb.cells[colIdx]), dir);
    });

    const frag = document.createDocumentFragment();
    rows.forEach(function (r) { frag.appendChild(r); });
    tbody.appendChild(frag);

    ths.forEach(function (h) {
      h.classList.remove("sort-asc", "sort-desc");
      delete h.dataset.dir;
      h.setAttribute("aria-sort", "none");
    });
    th.classList.add("sort-" + dir);
    th.dataset.dir = dir;
    th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
  }

  document.querySelectorAll("table.tx-table").forEach(attach);
})();

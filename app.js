// Page logic: read the form, show the call count, trigger the GitHub Actions job, show results.json.
(function () {
  "use strict";
  const C = window.FlightCore;
  const REPO = "botbotzilla/flights", BRANCH = "main", WORKFLOW = "search.yml";
  const FREE_PER_MONTH = 250; // SerpApi free plan, per its docs page
  const FIELDS = ["from", "to", "outStart", "outEnd", "retStart", "retEnd", "adults", "children", "currency", "stops",
    "maxPrice", "maxHours", "layMin", "layMax", "oDepFrom", "oDepTo", "oArrFrom", "oArrTo", "rDepFrom", "rDepTo",
    "rArrFrom", "rArrTo", "maxCalls", "topN", "cabin", "airMode", "airCodes"];
  const CHECKS = ["alStar", "alSky", "alOne"];

  const $ = (id) => document.getElementById(id);
  const today = () => new Date().toISOString().slice(0, 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: page still works */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const num = (id) => { const v = $(id).value.trim(); return v === "" ? null : Number(v); };
  const mins = (id) => { const n = num(id); return n === null ? null : Math.round(n * 60); };
  const times = (p) => ({ depFrom: num(p + "DepFrom"), depTo: num(p + "DepTo"), arrFrom: num(p + "ArrFrom"), arrTo: num(p + "ArrTo") });
  const codes = (id) => $(id).value.toUpperCase().replace(/[^A-Z,]/g, "");

  function airlines() {
    const alliances = [["alStar", "STAR_ALLIANCE"], ["alSky", "SKYTEAM"], ["alOne", "ONEWORLD"]]
      .filter(([id]) => $(id).checked).map(([, code]) => code);
    const typed = $("airCodes").value.toUpperCase().split(/[\s,]+/).filter(Boolean);
    return { mode: $("airMode").value, codes: [...new Set([...alliances, ...typed])] };
  }

  function readForm() {
    const os = $("outStart").value, rs = $("retStart").value;
    return {
      from: codes("from"), to: codes("to"),
      outbound: { start: os, end: $("outEnd").value || os },
      return: { start: rs, end: $("retEnd").value || rs },
      adults: num("adults"), children: num("children"),
      currency: $("currency").value.trim().toUpperCase(),
      stops: Number($("stops").value),
      travelClass: Number($("cabin").value), airlines: airlines(),
      maxPrice: num("maxPrice"), maxDuration: mins("maxHours"),
      layover: { min: mins("layMin"), max: mins("layMax") },
      outboundTimes: times("o"), returnTimes: times("r"),
      maxCalls: num("maxCalls"), topN: num("topN"),
    };
  }

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) n.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) n.append(kid);
    return n;
  }

  function status(msg, bad) { const s = $("status"); s.textContent = msg; s.className = bad ? "bad" : ""; }

  // ---- live call count and cap ----
  const datesOk = (r) => C.parseDate(r.start) !== null && C.parseDate(r.end) !== null && r.start <= r.end
    && (C.parseDate(r.end) - C.parseDate(r.start)) / 86400000 <= 400;

  function refreshCount() {
    const c = readForm();
    const errs = C.validateConfig(c, today());
    const pairs = datesOk(c.outbound) && datesOk(c.return) ? C.datePairs(c).length : null;
    const count = $("count");
    count.className = errs.length ? "bad" : "";
    count.textContent = pairs === null ? "Pick dates to see the call count"
      : `${pairs} date pair${pairs === 1 ? "" : "s"} = ${pairs} API call${pairs === 1 ? "" : "s"} this run (${FREE_PER_MONTH} free a month)`;
    const list = $("errors");
    list.replaceChildren(...errs.map((e) => el("li", null, e)));
    $("run").disabled = errs.length > 0;
    store.set("flights.form", JSON.stringify({
      ...Object.fromEntries(FIELDS.map((f) => [f, $(f).value])),
      ...Object.fromEntries(CHECKS.map((f) => [f, $(f).checked])),
    }));
    return c;
  }

  // ---- results ----
  let lastGenerated = null;

  async function fetchResults() {
    const headers = { Accept: "application/vnd.github.raw+json" };
    const tok = $("token").value.trim();
    if (tok) headers.Authorization = "Bearer " + tok;
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/results.json?ref=${BRANCH}`, { headers, cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("GitHub returned " + res.status);
    return JSON.parse(await res.text());
  }

  const when = (s) => String(s).slice(5, 16).replace("-", "/"); // "2026-11-24 22:10" -> "11/24 22:10"

  function renderResults(data) {
    const box = $("results");
    if (!data) { lastGenerated = null; box.replaceChildren(el("p", { class: "sub" }, "No results yet. Run a search.")); return; }
    lastGenerated = data.generatedAt;
    const cur = (data.config && data.config.currency) || "";
    const parts = [];
    if (data.sample) parts.push(el("div", { class: "banner" }, "Sample data, not a live search. These are saved example flights used for testing."));
    parts.push(el("p", { class: "sub" },
      `Run ${new Date(data.generatedAt).toLocaleString()}: ${data.counts.pairs} date pairs, ${data.counts.calls} API calls, ${data.counts.options} options found, ${data.counts.passing} meet every filter.`));
    if (data.errors && data.errors.length)
      parts.push(el("ul", { id: "runerrors", style: "color:var(--bad)" },
        data.errors.map((e) => el("li", null, (e.pair ? `${e.pair[0]} to ${e.pair[1]}: ` : "") + e.error))));
    if (data.results.length) {
      const rows = data.results.map((r) => {
        const clean = r.issues.length === 0;
        return el("tr", { class: clean ? "clean" : "flagged" },
          el("td", { class: "price" }, r.price === null ? "n/a" : `${cur} ${r.price.toLocaleString()}`),
          el("td", null, `${r.outbound_date} to ${r.return_date}`),
          el("td", null, String(r.stops)),
          el("td", null, r.total_minutes === null ? "n/a" : C.fmtMin(r.total_minutes)),
          el("td", null, el("ul", { class: "plain" }, r.legs.map((l) =>
            el("li", null, `${l.from} ${when(l.dep)} to ${l.to} ${when(l.arr)} · ${l.airline || ""} ${l.flight || ""}${l.cabin ? " · " + l.cabin : ""}`)))),
          el("td", null, r.layovers.length ? el("ul", { class: "plain" }, r.layovers.map((l) =>
            el("li", null, `${l.airport} ${C.fmtMin(l.minutes)}${l.overnight ? " overnight" : ""}`))) : "none"),
          el("td", null, clean ? el("span", { class: "ok" }, "OK")
            : el("ul", { class: "plain flag" }, r.issues.map((i) => el("li", null, i)))),
          el("td", null, r.link && r.link.startsWith("https://www.google.com/") ? el("a", { href: r.link, target: "_blank", rel: "noopener" }, "Google Flights") : ""));
      });
      parts.push(el("div", { class: "tablewrap" }, el("table", null,
        el("thead", null, el("tr", null, ["Price", "Dates", "Stops", "Outbound time", "Outbound flights", "Stopovers", "Checks", "Link"].map((h) => el("th", null, h)))),
        el("tbody", null, rows))));
      parts.push(el("p", { class: "hint" },
        "Price is the round-trip price the API returned. Times are outbound only; the link opens the Google Flights search for the return legs. Rows marked with checks broke one of your filters even though the API returned them."));
    } else if (!(data.errors && data.errors.length)) parts.push(el("p", { class: "sub" }, "The search ran but returned no flights."));
    box.replaceChildren(...parts);
  }

  async function showResults() {
    try { renderResults(await fetchResults()); }
    catch (e) { $("results").replaceChildren(el("p", { class: "flag", style: "color:var(--bad)" }, "Could not load results: " + e.message)); }
  }

  // ---- run ----
  async function poll(before) {
    for (let i = 1; i <= 16; i++) {
      await sleep(15000);
      try {
        const d = await fetchResults();
        if (d && d.generatedAt !== before) { renderResults(d); status("Done."); return; }
      } catch { /* keep waiting */ }
      status(`Waiting for the job… ${i * 15}s`);
    }
    status("Still waiting. Check the Actions tab on GitHub, then press Refresh results.", true);
  }

  async function run() {
    const c = refreshCount();
    if (C.validateConfig(c, today()).length) return;
    const tok = $("token").value.trim();
    if (!tok) return status("Paste a GitHub token first (see How to get the token).", true);
    const n = C.datePairs(c).length;
    if (!window.confirm(`This will use ${n} of your ${FREE_PER_MONTH} free searches this month. Run?`)) return;
    if ($("remember").checked) store.set("flights.token", tok); else store.del("flights.token");
    $("run").disabled = true;
    status("Sending…");
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + tok, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: BRANCH, inputs: { config: JSON.stringify(c) } }),
      });
      if (res.status === 204) { status("Started. Results usually take a minute or two."); poll(lastGenerated); }
      else if (res.status === 401) status("GitHub rejected the token (401). Check it was pasted whole and has not expired.", true);
      else if (res.status === 403) status("The token is not allowed to run workflows (403). It needs Actions: Read and write on this repository.", true);
      else if (res.status === 404) status("GitHub could not find the workflow (404). Either it is not on the main branch yet, or the token cannot see this repository.", true);
      else status(`GitHub returned ${res.status}. Nothing was run.`, true);
    } catch (e) { status("Could not reach GitHub: " + e.message, true); }
    refreshCount();
  }

  // ---- start up ----
  const saved = store.get("flights.form");
  if (saved) {
    try {
      const o = JSON.parse(saved);
      for (const f of FIELDS) if (typeof o[f] === "string") $(f).value = o[f];
      for (const f of CHECKS) if (typeof o[f] === "boolean") $(f).checked = o[f];
    } catch { /* ignore bad saved data */ }
  }
  const tok = store.get("flights.token");
  if (tok) $("token").value = tok;

  $("form").addEventListener("input", refreshCount);
  $("run").addEventListener("click", run);
  $("refresh").addEventListener("click", showResults);
  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(readForm(), null, 2)); status("Config copied."); }
    catch { status("Could not copy. Your browser blocked clipboard access.", true); }
  });
  refreshCount();
  showResults();
})();

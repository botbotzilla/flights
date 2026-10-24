"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const core = require("../core.js");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "sample.json"), "utf8"));
// Fixture order: 0 PEK 2-stop, 1 PEK 2-stop (overnight layover), 2 CDG-IST, 3 ORY-LGW, 4 CDG-DUB
const options = core.collect(fixture);

const base = {
  from: "SIN", to: "SYD",
  outbound: { start: "2026-11-21", end: "2026-11-27" },
  return: { start: "2026-12-31", end: "2027-01-15" },
  adults: 1, children: 1, currency: "SGD", stops: 0,
  maxPrice: null, maxDuration: null, layover: { min: null, max: null },
  outboundTimes: null, returnTimes: null, maxCalls: 112, topN: 5,
};
const TODAY = "2026-10-24";
const cfg = (o) => ({ ...base, ...o });

function flagged(over) {
  const c = cfg(over);
  return options
    .map((o, i) => ({ i, r: core.normalizeOption(o, ["2026-11-24", "2027-01-05"], null) }))
    .filter(({ r }) => core.checkRules(r, c).length > 0)
    .map(({ i }) => i);
}

test("date pairs: Search 1 grid is 7 x 16 = 112; single dates give 1", () => {
  assert.equal(core.datePairs(base).length, 112);
  assert.equal(core.datePairs(cfg({ outbound: { start: "2026-11-24", end: "2026-11-24" }, return: { start: "2027-01-05", end: "2027-01-05" } })).length, 1);
});

test("date pairs: returns on or before the outbound are dropped", () => {
  const c = cfg({ outbound: { start: "2027-01-10", end: "2027-01-12" }, return: { start: "2027-01-11", end: "2027-01-11" } });
  assert.deepEqual(core.datePairs(c), [["2027-01-10", "2027-01-11"]]);
});

const small = { outbound: { start: "2026-11-24", end: "2026-11-25" }, return: { start: "2027-01-04", end: "2027-01-06" }, maxCalls: 10 }; // 2 x 3 = 6 pairs

test("validate: a small config passes, and the cap blocks an over-budget run", () => {
  assert.deepEqual(core.validateConfig(cfg(small), TODAY), []);
  const errs = core.validateConfig(cfg({ ...small, maxCalls: 5 }), TODAY);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /6 date pairs means 6 API calls, over your cap of 5/);
});

test("validate: the full Search 1 grid (112 calls) is refused by the 50-call hard cap", () => {
  assert.ok(core.validateConfig(cfg({ maxCalls: 112 }), TODAY).some((e) => /Max calls: 1-50/.test(e)));
  assert.ok(core.validateConfig(cfg({ maxCalls: 50 }), TODAY).some((e) => /112 API calls, over your cap of 50/.test(e)));
});

test("validate: rejects bad input", () => {
  const bad = (o, re) => assert.ok(core.validateConfig(cfg(o), TODAY).some((e) => re.test(e)), JSON.stringify(o));
  bad({ from: "SYDNEY" }, /From/);
  bad({ to: "" }, /To:/);
  bad({ currency: "sg" }, /Currency/);
  bad({ adults: 0 }, /Adults/);
  bad({ adults: 5, children: 5 }, /Children/);
  bad({ stops: 9 }, /Stops/);
  bad({ outbound: { start: "2026-10-01", end: "2026-10-02" } }, /in the past/);
  bad({ outbound: { start: "2026-02-31", end: "2026-03-02" } }, /real dates/);
  bad({ return: { start: "2027-01-10", end: "2027-01-01" } }, /start is after end/);
  bad({ layover: { min: 300, max: 60 } }, /minimum is above maximum/);
  bad({ outboundTimes: { depFrom: 19, depTo: null, arrFrom: null, arrTo: null } }, /fill both hours or neither/);
  bad({ outboundTimes: { depFrom: 20, depTo: 7, arrFrom: null, arrTo: null } }, /after "to" hour/);
  bad({ maxCalls: 100 }, /Max calls/);
  bad({ outbound: { start: "2027-01-05", end: "2027-01-05" }, return: { start: "2027-01-01", end: "2027-01-02" } }, /No date pairs/);
});

test("times string follows SerpApi's format", () => {
  assert.equal(core.timesString({ depFrom: 19, depTo: 23, arrFrom: null, arrTo: null }), "19,23");
  assert.equal(core.timesString({ depFrom: null, depTo: null, arrFrom: 0, arrTo: 0 }), "0,23,0,0");
  assert.equal(core.timesString({ depFrom: 4, depTo: 18, arrFrom: 3, arrTo: 19 }), "4,18,3,19");
  assert.equal(core.timesString({ depFrom: null, depTo: null, arrFrom: null, arrTo: null }), null);
  assert.equal(core.timesString(null), null);
});

test("params: filters map to SerpApi names, blanks are omitted, no api_key", () => {
  const pair = ["2026-11-24", "2027-01-05"];
  const bare = core.buildParams(cfg({ children: 0 }), pair);
  assert.deepEqual(bare, {
    engine: "google_flights", type: "1", hl: "en", departure_id: "SIN", arrival_id: "SYD",
    outbound_date: "2026-11-24", return_date: "2027-01-05", currency: "SGD", adults: "1",
  });
  const full = core.buildParams(cfg({
    stops: 2, maxPrice: 3000, maxDuration: 840, layover: { min: null, max: 240 },
    outboundTimes: { depFrom: 7, depTo: 23, arrFrom: 0, arrTo: 0 },
    returnTimes: { depFrom: 19, depTo: 23, arrFrom: null, arrTo: null },
  }), pair);
  assert.equal(full.children, "1");
  assert.equal(full.stops, "2");
  assert.equal(full.max_price, "3000");
  assert.equal(full.max_duration, "840");
  assert.equal(full.layover_duration, "0,240");
  assert.equal(full.outbound_times, "7,23,0,0");
  assert.equal(full.return_times, "19,23");
  assert.ok(!("api_key" in full));
});

test("rules: control run with no filters flags nothing", () => {
  assert.deepEqual(flagged({}), []);
});

test("rules: each filter flags exactly the options that break it", () => {
  assert.deepEqual(flagged({ stops: 2 }), [0, 1]); // 1 stop or fewer
  assert.deepEqual(flagged({ stops: 1 }), [0, 1, 2, 3, 4]); // nonstop only
  assert.deepEqual(flagged({ maxDuration: 1000 }), [0, 1, 2]); // 970 and 860 pass
  assert.deepEqual(flagged({ maxDuration: 860 }), [0, 1, 2, 3]); // exactly 860 passes
  assert.deepEqual(flagged({ layover: { min: null, max: 240 } }), [1, 2]);
  assert.deepEqual(flagged({ layover: { min: 100, max: null } }), [0, 4]);
  assert.deepEqual(flagged({ maxPrice: 1000 }), [0, 1, 4]);
  assert.deepEqual(flagged({ outboundTimes: { depFrom: 7, depTo: 15, arrFrom: null, arrTo: null } }), [2]);
  assert.deepEqual(flagged({ outboundTimes: { depFrom: null, depTo: null, arrFrom: 0, arrTo: 14 } }), [0, 3, 4]);
});

test("rank: clean options first, cheapest first, then flagged", () => {
  const c = cfg({ stops: 2 });
  const rs = options.map((o) => {
    const r = core.normalizeOption(o, ["2026-11-24", "2027-01-05"], null);
    r.issues = core.checkRules(r, c);
    return r;
  });
  assert.deepEqual(core.rank(rs, 5).map((r) => r.price), [887, 890, 1240, 2512, 2513]);
  assert.deepEqual(core.rank(rs, 2).map((r) => r.price), [887, 890]);
});

test("normalize: stops, layovers and legs come through", () => {
  const r = core.normalizeOption(options[0], ["2026-11-24", "2027-01-05"], "https://x");
  assert.equal(r.stops, 2);
  assert.equal(r.price, 2512);
  assert.equal(r.total_minutes, 1309);
  assert.deepEqual(r.layovers.map((l) => l.minutes), [90, 231]);
  assert.equal(r.legs[0].from, "PEK");
  assert.equal(r.legs[2].arr, "2023-10-03 23:59");
  assert.equal(r.link, "https://x");
});

// ---- the script, run end to end with no network ----
const script = path.join(__dirname, "..", "scripts", "run-search.js");
const day = (n) => core.fmtDate(Date.now() + n * 86400000);
function run(env, args = []) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flights-")), "results.json");
  const e = { ...process.env, RESULTS_PATH: out, ...env };
  if (env.SERPAPI_KEY === undefined) delete e.SERPAPI_KEY;
  const p = spawnSync(process.execPath, [script, ...args], { env: e, encoding: "utf8" });
  return { code: p.status, text: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "", stderr: p.stderr };
}
const oneDay = cfg({ outbound: { start: day(30), end: day(30) }, return: { start: day(50), end: day(50) }, maxCalls: 10, stops: 2 });

test("script: sample mode writes ranked results, makes no API calls, never writes the key", () => {
  const r = run({ SEARCH_CONFIG: JSON.stringify(oneDay), SERPAPI_KEY: "SECRET123" }, ["--sample", path.join(__dirname, "fixtures", "sample.json")]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.text.includes("SECRET123"));
  const j = JSON.parse(r.text);
  assert.equal(j.sample, true);
  assert.deepEqual(j.counts, { pairs: 1, calls: 0, options: 5, passing: 3 });
  assert.deepEqual(j.results.map((x) => x.price), [887, 890, 1240, 2512, 2513]);
  assert.equal(j.results[0].issues.length, 0);
  assert.match(j.results[3].issues[0], /2 stops/);
  assert.equal(j.results[0].link, "https://www.google.com/travel/flights?hl=en");
  assert.deepEqual(j.errors, []);
});

test("script: refuses to run without a key, and says why in results.json", () => {
  const r = run({ SEARCH_CONFIG: JSON.stringify(oneDay) });
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.text).errors[0].error, /SERPAPI_KEY/);
});

test("script: over-cap config is refused before any call", () => {
  const over = cfg({ outbound: { start: day(30), end: day(36) }, return: { start: day(60), end: day(75) }, maxCalls: 10 });
  const r = run({ SEARCH_CONFIG: JSON.stringify(over), SERPAPI_KEY: "SECRET123" });
  assert.equal(r.code, 1);
  const j = JSON.parse(r.text);
  assert.match(j.errors[0].error, /over your cap of 10/);
  assert.equal(j.counts.calls, 0);
  assert.ok(!r.text.includes("SECRET123"));
});

test("script: bad JSON is refused", () => {
  const r = run({ SEARCH_CONFIG: "{nope", SERPAPI_KEY: "SECRET123" });
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.text).errors[0].error, /not valid JSON/);
});

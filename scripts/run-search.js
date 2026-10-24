#!/usr/bin/env node
// Runs one search config against SerpApi's Google Flights endpoint and writes results.json.
// Config comes in as JSON in SEARCH_CONFIG; the key as SERPAPI_KEY (a GitHub secret in Actions).
// `--sample file.json` reads a saved response instead of calling the API (no key, no calls).
"use strict";
const fs = require("fs");
const path = require("path");
const core = require("../core.js");

const sampleAt = process.argv.indexOf("--sample");
const samplePath = sampleAt > -1 ? process.argv[sampleAt + 1] : null;
const outPath = process.env.RESULTS_PATH || path.join(__dirname, "..", "results.json");
const key = process.env.SERPAPI_KEY || "";
const STOP_ON = [401, 403, 429]; // bad key, blocked, out of searches: further calls would fail too
const NO_RESULTS = /hasn't returned any results/i;

const clean = (s) => (key ? String(s).split(key).join("***") : String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function write(obj) {
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + "\n");
}

function fail(message) {
  console.error(clean(message));
  write({
    generatedAt: new Date().toISOString(), sample: !!samplePath, config: null,
    counts: { pairs: 0, calls: 0, options: 0, passing: 0 }, results: [], errors: [{ error: clean(message) }],
  });
  process.exit(1);
}

async function callApi(params) {
  const url = "https://serpapi.com/search.json?" + new URLSearchParams({ ...params, api_key: key });
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (body && body.error && NO_RESULTS.test(body.error)) return { best_flights: [], other_flights: [] };
  if (!res.ok || !body || body.error) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function main() {
  let cfg;
  try { cfg = JSON.parse(process.env.SEARCH_CONFIG || ""); } catch { return fail("SEARCH_CONFIG is not valid JSON"); }
  const problems = core.validateConfig(cfg, new Date().toISOString().slice(0, 10));
  if (problems.length) return fail(problems.join("; "));
  if (!samplePath && !key) return fail("SERPAPI_KEY is not set. Add it under Settings, Secrets and variables, Actions.");

  const pairs = core.datePairs(cfg);
  const all = [], errors = [];
  let calls = 0;
  for (const pair of pairs) {
    try {
      let body;
      if (samplePath) body = JSON.parse(fs.readFileSync(samplePath, "utf8"));
      else {
        calls++;
        body = await callApi(core.buildParams(cfg, pair));
        await sleep(500);
      }
      const link = body.search_metadata && body.search_metadata.google_flights_url;
      for (const opt of core.collect(body)) {
        const r = core.normalizeOption(opt, pair, link);
        r.issues = core.checkRules(r, cfg);
        all.push(r);
      }
    } catch (e) {
      errors.push({ pair, error: clean(e.message) });
      if (STOP_ON.includes(e.status)) break;
    }
  }

  write({
    generatedAt: new Date().toISOString(), sample: !!samplePath, config: cfg,
    counts: { pairs: pairs.length, calls, options: all.length, passing: all.filter((r) => !r.issues.length).length },
    results: core.rank(all, cfg.topN), errors,
  });
  console.log(`pairs ${pairs.length}, calls ${calls}, options ${all.length}, errors ${errors.length}`);
  if (errors.length === pairs.length) process.exitCode = 1;
}

main().catch((e) => fail(e.message));

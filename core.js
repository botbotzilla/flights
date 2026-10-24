// Shared logic for the page (browser) and the search script (Node).
// Pure functions only: no network, no DOM, no API key.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FlightCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;
  const HARD_MAX_CALLS = 50;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const AIRPORTS = /^[A-Z]{3}(,[A-Z]{3}){0,9}$/;
  const AIRLINE = /^((?=.*[A-Z])[A-Z0-9]{2}|STAR_ALLIANCE|SKYTEAM|ONEWORLD)$/; // IATA code or alliance
  const MAX_STOPS = { 1: 0, 2: 1, 3: 2 }; // SerpApi stops code -> max stops; 0 = any

  function parseDate(s) {
    if (typeof s !== "string" || !ISO.test(s)) return null;
    const t = Date.parse(s + "T00:00:00Z");
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10) === s ? t : null; // rejects 2026-02-31
  }
  const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);
  const fmtMin = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;

  function days(start, end) {
    const out = [];
    for (let t = parseDate(start); t <= parseDate(end); t += DAY) out.push(fmtDate(t));
    return out;
  }

  // Every outbound/return combination where the return is after the outbound.
  function datePairs(c) {
    const out = [];
    const rets = days(c.return.start, c.return.end);
    for (const od of days(c.outbound.start, c.outbound.end))
      for (const rd of rets) if (rd > od) out.push([od, rd]);
    return out;
  }

  const isInt = Number.isInteger;
  const optInt = (v, lo, hi) => v === null || v === undefined || (isInt(v) && v >= lo && v <= hi);

  // A time window is optional on each side: empty "from" = 0, empty "to" = 23.
  // "from" later than "to" means the window crosses midnight (6 to 0 = 06:00 through 00:59).
  function norm(a, b) {
    const set = (v) => v !== null && v !== undefined;
    if (!set(a) && !set(b)) return null;
    const w = { from: set(a) ? a : 0, to: set(b) ? b : 23 };
    return w.from === 0 && w.to === 23 ? null : w; // the whole day is no limit
  }
  const wraps = (w) => w !== null && w.from > w.to;
  const inWin = (h, w) => (w.from <= w.to ? h >= w.from && h <= w.to : h >= w.from || h <= w.to);
  const hh = (h, end) => `${String(h).padStart(2, "0")}:${end ? "59" : "00"}`;
  const describe = (w) => `${hh(w.from)} to ${hh(w.to, true)}`;

  function checkTimes(t, name, e, allowWrap) {
    if (t === null || t === undefined) return;
    for (const [a, b, label] of [["depFrom", "depTo", "departure"], ["arrFrom", "arrTo", "arrival"]]) {
      if (!optInt(t[a], 0, 23) || !optInt(t[b], 0, 23)) e.push(`${name} ${label} hours must be whole numbers 0-23`);
      else if (!allowWrap && wraps(norm(t[a], t[b])))
        e.push(`${name} ${label} window crosses midnight, which can't be applied to return flights yet`);
    }
  }

  // Returns a list of problems; empty means the config is safe to run.
  function validateConfig(c, today) {
    const e = [];
    if (!c || typeof c !== "object") return ["config is missing"];
    if (!AIRPORTS.test(c.from || "")) e.push("From: use 1-10 airport codes such as SIN or SIN,CGK");
    if (!AIRPORTS.test(c.to || "")) e.push("To: use 1-10 airport codes such as SYD or SYD,MEL");
    if (!/^[A-Z]{3}$/.test(c.currency || "")) e.push("Currency: use a 3-letter code such as SGD");
    if (!isInt(c.adults) || c.adults < 1 || c.adults > 9) e.push("Adults: 1-9");
    if (!isInt(c.children) || c.children < 0 || c.adults + c.children > 9) e.push("Children: 0 or more, 9 passengers in total at most");
    if (![0, 1, 2, 3].includes(c.stops)) e.push("Stops: pick one of the options");
    if (!optInt(c.maxPrice, 1, 1e7)) e.push("Max price: a whole number");
    if (!optInt(c.maxDuration, 30, 6000)) e.push("Max flight time: 0.5 to 100 hours");
    const lo = c.layover || {};
    if (!optInt(lo.min, 0, 1800) || !optInt(lo.max, 0, 1800)) e.push("Stopover: 0 to 30 hours");
    else if (isInt(lo.min) && isInt(lo.max) && lo.min > lo.max) e.push("Stopover: minimum is above maximum");
    checkTimes(c.outboundTimes, "Outbound", e, true);
    checkTimes(c.returnTimes, "Return", e, false);
    if (c.travelClass !== undefined && ![1, 2, 3, 4].includes(c.travelClass)) e.push("Cabin: pick one of the options");
    const al = c.airlines;
    if (al !== undefined) {
      if (!al || !["any", "include", "exclude"].includes(al.mode)) e.push("Airlines: pick any, only these, or exclude these");
      else if (al.mode !== "any") {
        const list = Array.isArray(al.codes) ? al.codes : [];
        if (list.length === 0) e.push("Airlines: add at least one airline code or alliance");
        else if (list.length > 20 || !list.every((x) => AIRLINE.test(x)))
          e.push("Airlines: use 2-character codes such as SQ or QF, or STAR_ALLIANCE, SKYTEAM, ONEWORLD (20 at most)");
      }
    }
    if (!isInt(c.maxCalls) || c.maxCalls < 1 || c.maxCalls > HARD_MAX_CALLS) e.push(`Max calls: 1-${HARD_MAX_CALLS}`);
    if (!isInt(c.topN) || c.topN < 1 || c.topN > 50) e.push("Results to keep: 1-50");

    let datesOk = true;
    for (const [name, r] of [["Departure", c.outbound], ["Return", c.return]]) {
      const a = r && parseDate(r.start), b = r && parseDate(r.end);
      if (a === null || b === null || a === undefined || b === undefined) { e.push(`${name} dates: use real dates`); datesOk = false; }
      else if (a > b) { e.push(`${name} dates: start is after end`); datesOk = false; }
      else if ((b - a) / DAY > 400) { e.push(`${name} dates: range is over 400 days`); datesOk = false; }
      else if (today && r.start < today) { e.push(`${name} dates: start is in the past`); datesOk = false; }
    }
    if (datesOk) {
      const n = datePairs(c).length;
      if (n === 0) e.push("No date pairs: every return is on or before every departure");
      else if (isInt(c.maxCalls) && n > c.maxCalls) e.push(`${n} date pairs means ${n} API calls, over your cap of ${c.maxCalls}`);
    }
    return e;
  }

  // "depFrom,depTo[,arrFrom,arrTo]" as SerpApi wants it; each number is the start of an hour.
  // Windows that cross midnight are not sent (unknown whether the API accepts them); checkRules applies them.
  function timesString(t) {
    if (!t) return null;
    const send = (a, b) => { const w = norm(a, b); return w && !wraps(w) ? w : null; };
    const dep = send(t.depFrom, t.depTo), arr = send(t.arrFrom, t.arrTo);
    if (!dep && !arr) return null;
    const d = dep ? [dep.from, dep.to] : [0, 23];
    return (arr ? [...d, arr.from, arr.to] : d).join(",");
  }

  // Query parameters for one date pair. The API key is added by the script, never here.
  function buildParams(c, pair) {
    const p = {
      engine: "google_flights", type: "1", hl: "en",
      departure_id: c.from, arrival_id: c.to,
      outbound_date: pair[0], return_date: pair[1],
      currency: c.currency, adults: String(c.adults),
    };
    if (c.children) p.children = String(c.children);
    if (c.travelClass && c.travelClass !== 1) p.travel_class = String(c.travelClass);
    const al = c.airlines;
    if (al && al.mode !== "any" && al.codes && al.codes.length)
      p[al.mode === "include" ? "include_airlines" : "exclude_airlines"] = al.codes.join(",");
    if (c.stops) p.stops = String(c.stops);
    if (c.maxPrice) p.max_price = String(c.maxPrice);
    if (c.maxDuration) p.max_duration = String(c.maxDuration);
    const lo = c.layover || {};
    if (isInt(lo.min) || isInt(lo.max)) p.layover_duration = [isInt(lo.min) ? lo.min : 0, isInt(lo.max) ? lo.max : 1800].join(",");
    const ot = timesString(c.outboundTimes), rt = timesString(c.returnTimes);
    if (ot) p.outbound_times = ot;
    if (rt) p.return_times = rt;
    return p;
  }

  const collect = (resp) => [...((resp && resp.best_flights) || []), ...((resp && resp.other_flights) || [])];

  // Flatten one SerpApi option into the shape the page and results.json use.
  function normalizeOption(opt, pair, link) {
    const flights = opt.flights || [];
    return {
      outbound_date: pair[0], return_date: pair[1],
      price: typeof opt.price === "number" ? opt.price : null,
      total_minutes: opt.total_duration ?? null,
      stops: Math.max(flights.length - 1, 0),
      layovers: (opt.layovers || []).map((l) => ({ airport: l.id, minutes: l.duration, overnight: !!l.overnight })),
      legs: flights.map((f) => ({
        from: f.departure_airport && f.departure_airport.id, to: f.arrival_airport && f.arrival_airport.id,
        dep: f.departure_airport && f.departure_airport.time, arr: f.arrival_airport && f.arrival_airport.time,
        airline: f.airline, flight: f.flight_number, cabin: f.travel_class, minutes: f.duration,
      })),
      link: link || null,
      issues: [],
    };
  }

  const hourOf = (ts) => Number(String(ts).slice(11, 13));

  // Our own check of the filters, so results the API let through anyway get flagged, not hidden.
  function checkRules(r, c) {
    const iss = [];
    if (r.price === null) iss.push("no price returned");
    const maxStops = MAX_STOPS[c.stops];
    if (maxStops !== undefined && r.stops > maxStops) iss.push(`${r.stops} stops (limit ${maxStops})`);
    if (c.maxPrice && r.price !== null && r.price > c.maxPrice) iss.push(`price ${r.price} over ${c.maxPrice}`);
    if (c.maxDuration && r.total_minutes !== null && r.total_minutes > c.maxDuration)
      iss.push(`${fmtMin(r.total_minutes)} total (limit ${fmtMin(c.maxDuration)})`);
    const lo = c.layover || {};
    for (const l of r.layovers) {
      if (isInt(lo.max) && l.minutes > lo.max) iss.push(`${fmtMin(l.minutes)} stopover at ${l.airport} (max ${fmtMin(lo.max)})`);
      if (isInt(lo.min) && l.minutes < lo.min) iss.push(`${fmtMin(l.minutes)} stopover at ${l.airport} (min ${fmtMin(lo.min)})`);
    }
    const t = c.outboundTimes, first = r.legs[0], last = r.legs[r.legs.length - 1];
    const dw = t && norm(t.depFrom, t.depTo), aw = t && norm(t.arrFrom, t.arrTo);
    if (dw && first && !inWin(hourOf(first.dep), dw)) iss.push(`departs ${String(first.dep).slice(11, 16)} (window ${describe(dw)})`);
    if (aw && last && !inWin(hourOf(last.arr), aw)) iss.push(`arrives ${String(last.arr).slice(11, 16)} (window ${describe(aw)})`);
    return iss;
  }

  // Options with no issues first, then cheapest first; no price goes last.
  function rank(results, topN) {
    const price = (r) => (r.price === null ? Infinity : r.price);
    return [...results]
      .sort((a, b) => (a.issues.length > 0) - (b.issues.length > 0) || price(a) - price(b))
      .slice(0, topN);
  }

  return { HARD_MAX_CALLS, parseDate, fmtDate, fmtMin, datePairs, validateConfig, timesString, buildParams, collect, normalizeOption, checkRules, rank };
});

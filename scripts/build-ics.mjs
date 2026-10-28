#!/usr/bin/env node
/**
 * Builds a filtered iCalendar file from Forex Factory's weekly feed.
 *
 *   node scripts/build-ics.mjs docs/usd.ics
 *
 * Default filter: USD, High + Medium impact.
 * If the upstream fetch fails, the script exits non-zero and writes nothing,
 * so the previously published calendar stays live.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CURRENCIES = ["USD"];
const IMPACTS = ["High"];
const ICON = { High: "🔴", Medium: "🟠", Low: "🟡", Holiday: "🏦" };
const EVENT_MINUTES = 15;
const ALERTS = [
  { minutes: 1440, label: "1 day before" },  // 24h = 1440 minutes
  { minutes: 60,   label: "60 min before" },
  { minutes: 10,    label: "10 min before" },
];

export function filterEvents(events, currencies = CURRENCIES, impacts = IMPACTS) {
  return events.filter(
    (e) =>
      e &&
      typeof e.title === "string" &&
      typeof e.date === "string" &&
      !isNaN(new Date(e.date).getTime()) &&
      impacts.includes(e.impact) &&
      currencies.includes(String(e.country).toUpperCase())
  );
}

export function buildICS(events, calName) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//unorthod0xd//ff-cal//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calName)}`,
    "X-WR-TIMEZONE:UTC",
    "REFRESH-INTERVAL;VALUE=DURATION:PT3H",
    "X-PUBLISHED-TTL:PT3H",
  ];

  const sorted = [...events].sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const e of sorted) {
    const start = new Date(e.date);
    const details = [];
    if (e.forecast) details.push(`Forecast: ${e.forecast}`);
    if (e.previous) details.push(`Previous: ${e.previous}`);
    details.push(`Impact: ${e.impact}`);

    // DTSTAMP is tied to the event, not the build time, so the file only
    // changes when the data changes (keeps git history quiet).
    lines.push("BEGIN:VEVENT", `UID:${uid(e, start)}`, `DTSTAMP:${utcStamp(start)}`);

    if (e.impact === "Holiday") {
      const day = e.date.slice(0, 10).replaceAll("-", "");
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextDay(day)}`, "TRANSP:TRANSPARENT");
    } else {
      const end = new Date(start.getTime() + EVENT_MINUTES * 60_000);
      lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`);
    }

    lines.push(
      `SUMMARY:${esc(`${ICON[e.impact] || ""} ${e.country} ${e.title}`.trim())}`,
      `DESCRIPTION:${esc(details.join("\n"))}`
    );
  
  if (e.impact === "High") {
    for (const a of ALERTS) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${esc(`${a.label} — ${e.country} ${e.title}`)}`,
        `TRIGGER:-PT${a.minutes}M`,
        "END:VALARM"
      );
    }
  }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

async function fetchWithRetry(url, attempts = 3) {
  const waits = [0, 30_000, 90_000];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "ff-cal (github.com/UNORTHOD0xd/ff-cal)" },
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break; // not worth retrying
    } catch (err) {
      lastErr = err;
    }
    console.warn(`Attempt ${i + 1} failed: ${lastErr.message}`);
  }
  throw lastErr;
}

async function main() {
  const out = process.argv[2] || "docs/usd.ics";
  const events = await fetchWithRetry(SOURCE);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("Upstream returned no events; refusing to overwrite calendar");
  }
  const filtered = filterEvents(events);
  const ics = buildICS(filtered, `FF ${CURRENCIES.join("/")} · ${IMPACTS.join(" + ")}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, ics, "utf8");
  console.log(`Wrote ${filtered.length} of ${events.length} events to ${out}`);
}

// --- helpers ---------------------------------------------------------------

function utcStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function nextDay(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replaceAll("-", "");
}

function uid(e, start) {
  const slug = `${e.country}-${e.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${utcStamp(start)}-${slug}@ff-cal`;
}

function esc(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + b > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  });
}

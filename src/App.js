import "./styles.css";
import React, { useMemo, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

/**
 * Email Analytics Interface Architect
 * Client-side React app: upload one raw CSV, auto-map columns, classify, dedupe, tab views.
 *
 * Notes:
 * - No backend, no persistence.
 * - Column names may vary; mapping uses flexible name matching.
 * - Open/Click Rate:
 *   - If CSV has rate columns, we use them.
 *   - Else we compute rates from Opens/Clicks and Total Recipients (necessary to satisfy required columns).
 * - Dedup "By email" collapses the same campaign sent to multiple segments into one row:
 *   sums Revenue/Orders/Recipients/Opens/Clicks and recomputes rates.
 */

// -----------------------------
// Utilities
// -----------------------------

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function cleanHeader(h) {
  return toStr(h)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\u2013\u2014]/g, "-");
}

function safeNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  // strip currency, commas
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function parseRate(v) {
  // Accept: 0.23, 23%, "23%", "0.23"
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s.includes("%")) {
    const n = safeNumber(s);
    return clamp01(n / 100);
  }
  const n = safeNumber(s);
  // heuristic: if > 1, treat as percent
  if (n > 1) return clamp01(n / 100);
  return clamp01(n);
}

function formatPct(x) {
  if (!Number.isFinite(x)) return "";
  return `${(x * 100).toFixed(1)}%`;
}

function formatMoney(x) {
  if (!Number.isFinite(x)) return "$0.00";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(x);
}

function parseDateMaybe(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function monthKey(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${y}-${m}`;
}

function daysAgo(date, now = new Date()) {
  const ms = now.getTime() - date.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function stripIdPrefix(name) {
  // Campaign IDs may appear at the start of the name.
  // Examples: "12345 - Winter Sale", "[12345] Winter Sale", "12345_Winter Sale"
  let s = toStr(name).trim();
  s = s.replace(/^\s*\[?\d{3,}\]?\s*[-_|:]\s*/i, "");
  s = s.replace(/^\s*id\s*\d{3,}\s*[-_|:]\s*/i, "");
  return s.trim();
}

function normalizeCampaignKey(name) {
  // dedupe key: stripped id prefix + collapse whitespace + lowercase
  return stripIdPrefix(name).toLowerCase().replace(/\s+/g, " ").trim();
}

function classifyEmailTypeFromName(name) {
  // Non-negotiable classification rules
  const s = toStr(name).toLowerCase();
  const isHype = s.includes("hype");
  const isSale =
    s.includes("sale") || s.includes("special offer") || s.includes("launch");
  if (isHype) return "hype";
  if (isSale) return "sale";
  return "evergreen";
}

function inferAudienceFromSegment(segmentName) {
  // Infer buyers vs leads from segment/list name text
  const s = toStr(segmentName).toLowerCase();
  const buyerHints = [
    "buyer",
    "buyers",
    "purchaser",
    "purchased",
    "customer",
    "customers",
    "placed order",
    "order",
    "repeat",
    "returning",
    "vip",
    "lifetime",
    "spent",
  ];
  const leadHints = [
    "lead",
    "leads",
    "prospect",
    "prospects",
    "newsletter",
    "subscribers",
    "signup",
    "sign up",
    "opt-in",
    "opt in",
    "non buyer",
    "non-buyer",
    "browse",
    "abandoned",
  ];

  const buyerScore = buyerHints.reduce(
    (acc, h) => (s.includes(h) ? acc + 1 : acc),
    0
  );
  const leadScore = leadHints.reduce(
    (acc, h) => (s.includes(h) ? acc + 1 : acc),
    0
  );

  if (buyerScore === 0 && leadScore === 0) return "unknown";
  if (buyerScore >= leadScore) return "buyers";
  return "leads";
}

function saleGroupNameFromCampaign(name) {
  // Heuristic: group sale emails under a common “sale name”
  // Goal: stable grouping without manual flags.
  // Rule: strip id prefix, then take the left side of common separators.
  const base = stripIdPrefix(name);
  const parts = base.split(/\s(?:-|\||:)\s/); // " - ", " | ", " : "
  const head = (parts[0] || base).trim();
  return head || base;
}

function guessColumnMapping(headers) {
  // Flexible name matching
  const H = headers.map(cleanHeader);
  const idx = (patterns) => {
    for (let i = 0; i < H.length; i++) {
      const h = H[i];
      if (
        patterns.some((p) => (p instanceof RegExp ? p.test(h) : h.includes(p)))
      )
        return i;
    }
    return -1;
  };

  return {
    campaignName: idx([
      "campaign message name",
      "message name",
      "campaign name",
      "email name",
      "name",
      /campaign.*message.*name/,
    ]),
    sendDate: idx([
      "send date",
      "sent at",
      "send time",
      "sent time",
      "sent date",
      "date",
      /send.*date/,
      /sent.*date/,
    ]),
    segment: idx([
      "segment",
      "list",
      "audience",
      "segment or list",
      /segment|list|audience/,
    ]),
    revenue: idx([
      "total placed order value",
      "placed order value",
      "revenue",
      "conversion value",
      "total revenue",
      /placed.*order.*value/,
    ]),
    recipients: idx([
      "total recipients",
      "recipients",
      "delivered",
      "emails delivered",
      "delivered count",
      "sent",
      /recipient|delivered|sent/,
    ]),
    opens: idx(["opens", "unique opens", "open", /open(s)?(\b|_)/]),
    clicks: idx(["clicks", "unique clicks", "click", /click(s)?(\b|_)/]),
    openRate: idx([
      "open rate",
      "unique open rate",
      "opens rate",
      /open\s*rate/,
    ]),
    clickRate: idx([
      "click rate",
      "unique click rate",
      "ctr",
      /click\s*rate|ctr/,
    ]),
    uniqueOrders: idx([
      "unique placed orders",
      "placed orders",
      "orders",
      "unique orders",
      /placed\s*orders|unique\s*orders|orders/,
    ]),
    subject: idx(["subject", "subject line", "email subject", /subject/]),
    preview: idx([
      "preview text",
      "preheader",
      "preheader text",
      "snippet",
      /preview|preheader/,
    ]),
  };
}

function parseCSV(text) {
  // Minimal CSV parser with quoted fields support.
  // Assumes first line is headers.
  const rows = [];
  let i = 0;
  const n = text.length;
  const readCell = () => {
    let out = "";
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < n) {
        const c = text[i];
        if (c === '"') {
          if (text[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += c;
        i++;
      }
    } else {
      while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
        out += text[i];
        i++;
      }
    }
    // move past delimiter
    if (!quoted) out = out.trim();
    return out;
  };

  const readRow = () => {
    const row = [];
    while (i < n) {
      const cell = readCell();
      row.push(cell);
      if (text[i] === ",") {
        i++;
        continue;
      }
      // newline
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      break;
    }
    return row;
  };

  // skip empty leading lines
  while (i < n && (text[i] === "\n" || text[i] === "\r")) i++;
  if (i >= n) return { headers: [], rows: [] };

  const headers = readRow();
  while (i < n) {
    // skip blank lines
    if (text[i] === "\n" || text[i] === "\r") {
      i++;
      continue;
    }
    const row = readRow();
    if (row.length === 1 && row[0] === "") continue;
    rows.push(row);
  }
  return { headers, rows };
}

// -----------------------------
// Data model
// -----------------------------

/**
 * CanonicalRow: normalized representation from raw CSV.
 * All values are sourced from raw fields, with only these computed/derived:
 * - monthSent: derived from sendDate
 * - openRate/clickRate may be computed if not present in CSV
 * - type: derived from campaign name (non-negotiable)
 * - audience: derived from segment/list name
 * - campaignKey: used for deduping
 * - saleGroup: used for sale grouping
 */

function buildCanonicalRows(headers, rows) {
  const mapping = guessColumnMapping(headers);
  const get = (r, idx) => (idx >= 0 ? r[idx] : "");

  const out = [];
  for (const r of rows) {
    const campaignName = toStr(get(r, mapping.campaignName));
    const segment = toStr(get(r, mapping.segment));
    const sendDateRaw = get(r, mapping.sendDate);
    const sendDate = parseDateMaybe(sendDateRaw);

    if (!campaignName || !sendDate) continue; // hard requirement

    const recipients = safeNumber(get(r, mapping.recipients));
    const opens = safeNumber(get(r, mapping.opens));
    const clicks = safeNumber(get(r, mapping.clicks));

    const openRateFromCSV = parseRate(get(r, mapping.openRate));
    const clickRateFromCSV = parseRate(get(r, mapping.clickRate));

    const openRate =
      openRateFromCSV !== null
        ? openRateFromCSV
        : recipients > 0
        ? clamp01(opens / recipients)
        : 0;
    const clickRate =
      clickRateFromCSV !== null
        ? clickRateFromCSV
        : recipients > 0
        ? clamp01(clicks / recipients)
        : 0;

    const revenue = safeNumber(get(r, mapping.revenue));
    const uniqueOrders = safeNumber(get(r, mapping.uniqueOrders));

    const subject = toStr(get(r, mapping.subject));
    const preview = toStr(get(r, mapping.preview));

    const type = classifyEmailTypeFromName(campaignName);
    const audience = inferAudienceFromSegment(segment);
    const monthSent = monthKey(sendDate);
    const campaignKey = normalizeCampaignKey(campaignName);
    const saleGroup =
      type === "sale" ? saleGroupNameFromCampaign(campaignName) : "";

    out.push({
      segment,
      campaignName,
      sendDate,
      sendDateRaw,
      openRate,
      clickRate,
      revenue,
      uniqueOrders,
      recipients,
      monthSent,
      subject,
      preview,
      type,
      audience,
      campaignKey,
      saleGroup,
      opens,
      clicks,
    });
  }

  return { rows: out, mapping, headers };
}

function dedupeByEmail(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = r.campaignKey;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    // Sum numeric fields
    const merged = { ...prev };
    merged.revenue += r.revenue;
    merged.uniqueOrders += r.uniqueOrders;
    merged.recipients += r.recipients;
    merged.opens += r.opens;
    merged.clicks += r.clicks;

    // Choose latest send date as representative
    if (r.sendDate.getTime() > prev.sendDate.getTime()) {
      merged.sendDate = r.sendDate;
      merged.sendDateRaw = r.sendDateRaw;
      merged.monthSent = r.monthSent;
      // Keep segment as "Multiple" if different
      merged.segment = prev.segment === r.segment ? prev.segment : "Multiple";
      // Keep subject/preview if latest has it, else fallback
      merged.subject = r.subject || prev.subject;
      merged.preview = r.preview || prev.preview;
      merged.campaignName = stripIdPrefix(r.campaignName) || prev.campaignName;
      merged.type = r.type;
      merged.saleGroup = r.saleGroup;
    } else {
      merged.segment = prev.segment === r.segment ? prev.segment : "Multiple";
      merged.subject = prev.subject || r.subject;
      merged.preview = prev.preview || r.preview;
    }

    // Recompute rates
    merged.openRate =
      merged.recipients > 0 ? clamp01(merged.opens / merged.recipients) : 0;
    merged.clickRate =
      merged.recipients > 0 ? clamp01(merged.clicks / merged.recipients) : 0;

    // Audience: if mixed, set unknown
    merged.audience = prev.audience === r.audience ? prev.audience : "unknown";

    byKey.set(key, merged);
  }
  return Array.from(byKey.values());
}

// -----------------------------
// Aggregation helpers (display-only)
// -----------------------------

function avg(list) {
  if (!list.length) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function summarizeRows(rows) {
  return {
    revenue: rows.reduce((a, r) => a + r.revenue, 0),
    avgOpenRate: avg(rows.map((r) => r.openRate)),
    avgClickRate: avg(rows.map((r) => r.clickRate)),
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const arr = m.get(k) || [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

function sortLatestFirst(rows) {
  return [...rows].sort((a, b) => b.sendDate.getTime() - a.sendDate.getTime());
}

function monthSortDesc(a, b) {
  return b.localeCompare(a);
}

// -----------------------------
// UI components
// -----------------------------

function Card({ title, value, sub }) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-gray-500">{title}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
      {sub ? <div className="mt-1 text-xs text-gray-500">{sub}</div> : null}
    </div>
  );
}

function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={
            "rounded-full border px-3 py-1.5 text-sm transition " +
            (active === t.key
              ? "bg-gray-900 text-white border-gray-900"
              : "bg-white text-gray-700 hover:bg-gray-50")
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Table({ rows }) {
  return (
    <div className="overflow-x-auto rounded-2xl border bg-white">
      <table className="min-w-[1200px] w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-600">
          <tr>
            {[
              "Segment",
              "Campaign Name",
              "Send Date",
              "Open Rate",
              "Click Rate",
              "Revenue",
              "Unique Placed Orders",
              "Total Recipients",
              "Month Sent",
              "Subject Line",
              "Preview Text",
            ].map((h) => (
              <th key={h} className="px-3 py-2 border-b">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx} className={idx % 2 ? "bg-white" : "bg-gray-50/40"}>
              <td className="px-3 py-2 border-b align-top">{r.segment}</td>
              <td className="px-3 py-2 border-b align-top">
                <div className="font-medium text-gray-900">
                  {r.campaignName}
                </div>
              </td>
              <td className="px-3 py-2 border-b align-top whitespace-nowrap">
                {r.sendDate.toLocaleString()}
              </td>
              <td className="px-3 py-2 border-b align-top">
                {formatPct(r.openRate)}
              </td>
              <td className="px-3 py-2 border-b align-top">
                {formatPct(r.clickRate)}
              </td>
              <td className="px-3 py-2 border-b align-top whitespace-nowrap">
                {formatMoney(r.revenue)}
              </td>
              <td className="px-3 py-2 border-b align-top">
                {r.uniqueOrders || ""}
              </td>
              <td className="px-3 py-2 border-b align-top">
                {r.recipients || ""}
              </td>
              <td className="px-3 py-2 border-b align-top">{r.monthSent}</td>
              <td
                className="px-3 py-2 border-b align-top max-w-[360px] truncate"
                title={r.subject}
              >
                {r.subject}
              </td>
              <td
                className="px-3 py-2 border-b align-top max-w-[360px] truncate"
                title={r.preview}
              >
                {r.preview}
              </td>
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td className="px-3 py-10 text-center text-gray-500" colSpan={11}>
                No rows to show.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function SummaryRow({ label, summary }) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-gray-500">{label}</div>
          <div className="mt-1 text-sm text-gray-700">
            Avg Open:{" "}
            <span className="font-semibold">
              {formatPct(summary.avgOpenRate)}
            </span>{" "}
            · Avg Click:{" "}
            <span className="font-semibold">
              {formatPct(summary.avgClickRate)}
            </span>
          </div>
        </div>
        <div className="text-lg font-semibold text-gray-900">
          {formatMoney(summary.revenue)}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {right ? <div>{right}</div> : null}
      </div>
      {children}
    </div>
  );
}

// -----------------------------
// Main App
// -----------------------------

export default function App() {
  const fileRef = useRef(null);
  const [rawText, setRawText] = useState("");
  const [activeTab, setActiveTab] = useState("all_evergreen_latest");
  const [dedupeMode, setDedupeMode] = useState("send"); // 'send' | 'email'
  const [audienceFilter, setAudienceFilter] = useState("all"); // all | buyers | leads

  const parsed = useMemo(() => {
    if (!rawText) return null;
    const { headers, rows } = parseCSV(rawText);
    if (!headers.length || !rows.length) return { error: "CSV looks empty." };
    const built = buildCanonicalRows(headers, rows);
    if (!built.rows.length) {
      return {
        error:
          "No usable rows. Ensure CSV includes Campaign Name + Send Date columns (names can vary).",
        meta: built,
      };
    }
    return { ...built };
  }, [rawText]);

  const baseRows = useMemo(() => {
    if (!parsed || parsed.error) return [];
    return parsed.rows;
  }, [parsed]);

  const workingRows = useMemo(() => {
    const rows = dedupeMode === "email" ? dedupeByEmail(baseRows) : baseRows;
    if (audienceFilter === "all") return rows;
    return rows.filter((r) => r.audience === audienceFilter);
  }, [baseRows, dedupeMode, audienceFilter]);

  const now = useMemo(() => new Date(), []);

  // Global KPIs (exclude hype from sale metrics, as specified)
  const globalKPIs = useMemo(() => {
    const all = workingRows;
    const evergreen = all.filter((r) => r.type === "evergreen");
    const saleNoHype = all.filter((r) => r.type === "sale");
    const saleRevenue = saleNoHype.reduce((a, r) => a + r.revenue, 0);
    const evergreenRevenue = evergreen.reduce((a, r) => a + r.revenue, 0);
    const totalRevenue =
      evergreenRevenue +
      saleRevenue +
      all.filter((r) => r.type === "hype").reduce((a, r) => a + r.revenue, 0);

    const emailsCount =
      dedupeMode === "email" ? all.length : dedupeByEmail(all).length;

    return {
      totalRevenue,
      evergreenRevenue,
      saleRevenue,
      avgRevPerEmail: emailsCount ? totalRevenue / emailsCount : 0,
      openRate: avg(all.map((r) => r.openRate)),
      clickRate: avg(all.map((r) => r.clickRate)),
    };
  }, [workingRows, dedupeMode]);

  // Chart datasets
  const monthRollup = useMemo(() => {
    const rows = workingRows;
    const byMonth = groupBy(rows, (r) => r.monthSent);
    const months = Array.from(byMonth.keys()).sort(monthSortDesc);
    return months
      .slice()
      .reverse()
      .map((m) => {
        const rs = byMonth.get(m) || [];
        const evergreen = rs.filter((r) => r.type === "evergreen");
        const sale = rs.filter((r) => r.type === "sale");
        const hype = rs.filter((r) => r.type === "hype");
        const revEvergreen = evergreen.reduce((a, r) => a + r.revenue, 0);
        const revSale = sale.reduce((a, r) => a + r.revenue, 0);
        const revHype = hype.reduce((a, r) => a + r.revenue, 0);
        return {
          month: m,
          revenue: revEvergreen + revSale + revHype,
          evergreen: revEvergreen,
          sale: revSale,
          openRate: avg(rs.map((r) => r.openRate)),
          clickRate: avg(rs.map((r) => r.clickRate)),
        };
      });
  }, [workingRows]);

  const rolling30 = useMemo(() => {
    const rows = workingRows.filter((r) => daysAgo(r.sendDate, now) <= 30);
    return summarizeRows(rows);
  }, [workingRows, now]);

  // Tab datasets
  const tabData = useMemo(() => {
    const all = workingRows;
    const evergreen = all.filter((r) => r.type === "evergreen");
    const saleAll = all.filter((r) => r.type === "sale" || r.type === "hype");

    const evergreenLatest = sortLatestFirst(evergreen);
    const saleLatest = sortLatestFirst(saleAll);

    const evergreenByMonth = groupBy(evergreenLatest, (r) => r.monthSent);
    const saleByMonth = groupBy(saleLatest, (r) => r.monthSent);

    const buyersEvergreenMonthly = new Map(
      Array.from(evergreenByMonth.entries()).map(([m, rs]) => [
        m,
        rs.filter((r) => r.audience === "buyers"),
      ])
    );

    const leadsEvergreenMonthly = new Map(
      Array.from(evergreenByMonth.entries()).map(([m, rs]) => [
        m,
        rs.filter((r) => r.audience === "leads"),
      ])
    );

    // Sale grouped by sale name (exclude hype from calculations)
    const saleNoHype = all.filter((r) => r.type === "sale");
    const saleGroups = groupBy(
      saleNoHype,
      (r) => r.saleGroup || "(Unlabeled Sale)"
    );

    // Totals monthly summary
    const totalsByMonth = groupBy(all, (r) => r.monthSent);
    const totalsMonths = Array.from(totalsByMonth.keys()).sort(monthSortDesc);

    return {
      evergreenLatest,
      saleLatest,
      evergreenByMonth,
      saleByMonth,
      buyersEvergreenMonthly,
      leadsEvergreenMonthly,
      saleGroups,
      totalsByMonth,
      totalsMonths,
    };
  }, [workingRows]);

  const tabs = useMemo(
    () => [
      { key: "all_evergreen_latest", label: "All Evergreen — Latest" },
      { key: "all_sale_latest", label: "All Sale — Latest" },
      { key: "evergreen_monthly", label: "Evergreen — Monthly" },
      { key: "sale_monthly", label: "Sale — Monthly" },
      {
        key: "buyers_evergreen_monthly",
        label: "Buyers — Evergreen (Monthly)",
      },
      { key: "leads_evergreen_monthly", label: "Leads — Evergreen (Monthly)" },
      { key: "sale_grouped", label: "Sale Performance — By Sale" },
      { key: "totals_monthly", label: "Totals — Monthly Summary" },
    ],
    []
  );

  const onPickFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setRawText(text);
    setActiveTab("all_evergreen_latest");
  };

  const MappingPreview = () => {
    if (!parsed || parsed.error) return null;
    const m = parsed.mapping;
    const item = (label, idx) => (
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-gray-700">{label}</div>
        <div className="text-sm font-medium text-gray-900">
          {idx >= 0 ? parsed.headers[idx] : "Not found"}
        </div>
      </div>
    );

    return (
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-900">
              Auto-mapped columns
            </div>
            <div className="text-xs text-gray-500">
              We’ll use these as the single source of truth.
            </div>
          </div>
          <div className="text-xs text-gray-500">
            Rows loaded: {parsed.rows.length}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {item("Campaign Name", m.campaignName)}
          {item("Send Date", m.sendDate)}
          {item("Segment/List", m.segment)}
          {item("Revenue", m.revenue)}
          {item("Recipients", m.recipients)}
          {item("Open Rate", m.openRate)}
          {item("Click Rate", m.clickRate)}
          {item("Opens", m.opens)}
          {item("Clicks", m.clicks)}
          {item("Unique Orders", m.uniqueOrders)}
          {item("Subject", m.subject)}
          {item("Preview", m.preview)}
        </div>
      </div>
    );
  };

  const Controls = () => (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => fileRef.current?.click()}
        className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
      >
        Upload CSV
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={".csv,text/csv"}
        className="hidden"
        onChange={(e) => onPickFile(e.target.files?.[0])}
      />

      <div className="ml-0 flex items-center gap-2 rounded-xl border bg-white px-3 py-2">
        <div className="text-xs font-semibold text-gray-600">View</div>
        <select
          className="bg-transparent text-sm text-gray-900 outline-none"
          value={dedupeMode}
          onChange={(e) => setDedupeMode(e.target.value)}
        >
          <option value="send">By send (segment-level)</option>
          <option value="email">By email (deduplicated)</option>
        </select>
      </div>

      <div className="flex items-center gap-2 rounded-xl border bg-white px-3 py-2">
        <div className="text-xs font-semibold text-gray-600">Audience</div>
        <select
          className="bg-transparent text-sm text-gray-900 outline-none"
          value={audienceFilter}
          onChange={(e) => setAudienceFilter(e.target.value)}
        >
          <option value="all">All</option>
          <option value="buyers">Buyers only</option>
          <option value="leads">Leads only</option>
        </select>
      </div>

      <div className="text-xs text-gray-500">
        30-day window: Revenue {formatMoney(rolling30.revenue)} · Avg Open{" "}
        {formatPct(rolling30.avgOpenRate)} · Avg Click{" "}
        {formatPct(rolling30.avgClickRate)}
      </div>
    </div>
  );

  const MonthlyBlocks = ({ map, includeSummary }) => {
    const months = Array.from(map.keys()).sort(monthSortDesc);
    return (
      <div className="space-y-6">
        {months.map((m) => {
          const rs = map.get(m) || [];
          const summary = summarizeRows(rs);
          return (
            <div key={m} className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-gray-900">{m}</div>
                <div className="text-xs text-gray-500">{rs.length} rows</div>
              </div>
              <Table rows={rs} />
              {includeSummary ? (
                <SummaryRow label={`${m} summary`} summary={summary} />
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const SaleGrouped = () => {
    const groups = tabData.saleGroups;
    const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

    return (
      <div className="space-y-6">
        {names.map((name) => {
          const rs = sortLatestFirst(groups.get(name) || []);
          const summary = summarizeRows(rs);
          return (
            <div key={name} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-gray-900">
                  {name}
                </div>
                <div className="text-xs text-gray-500">
                  {rs.length} emails in sale
                </div>
              </div>
              <Table rows={rs} />
              <SummaryRow
                label="Sale summary (display-only)"
                summary={summary}
              />
            </div>
          );
        })}
        {!names.length ? (
          <div className="rounded-2xl border bg-white p-6 text-sm text-gray-600">
            No sale emails found ("sale", "special offer", or "launch" in
            campaign name). Note: "hype" emails are excluded from this tab’s
            calculations.
          </div>
        ) : null}
      </div>
    );
  };

  const TotalsMonthly = () => {
    const months = tabData.totalsMonths;
    const rows = months.map((m) => {
      const rs = tabData.totalsByMonth.get(m) || [];
      const rev = rs.reduce((a, r) => a + r.revenue, 0);
      return {
        segment: "All",
        campaignName: `Monthly totals`,
        sendDate: new Date(`${m}-01T00:00:00`),
        openRate: avg(rs.map((r) => r.openRate)),
        clickRate: avg(rs.map((r) => r.clickRate)),
        revenue: rev,
        uniqueOrders: rs.reduce((a, r) => a + r.uniqueOrders, 0),
        recipients: rs.reduce((a, r) => a + r.recipients, 0),
        monthSent: m,
        subject: "",
        preview: "",
      };
    });

    return (
      <div className="space-y-3">
        <Table rows={rows} />
        <div className="text-xs text-gray-500">
          These rows are display-only monthly rollups across all campaigns.
        </div>
      </div>
    );
  };

  const Charts = () => {
    if (!monthRollup.length) return null;
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold text-gray-900">
            Revenue by month
          </div>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthRollup}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(v) => formatMoney(Number(v))} />
                <Legend />
                <Bar dataKey="revenue" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold text-gray-900">
            Evergreen vs sale revenue
          </div>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={monthRollup}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(v) => formatMoney(Number(v))} />
                <Legend />
                <Line type="monotone" dataKey="evergreen" dot={false} />
                <Line type="monotone" dataKey="sale" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Sale line excludes hype by definition of sale classification (hype
            is separate type).
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm lg:col-span-2">
          <div className="text-sm font-semibold text-gray-900">
            Open + click rate trends
          </div>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={monthRollup}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis
                  tickFormatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
                />
                <Tooltip formatter={(v) => formatPct(Number(v))} />
                <Legend />
                <Line type="monotone" dataKey="openRate" dot={false} />
                <Line type="monotone" dataKey="clickRate" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    );
  };

  const ActiveTabContent = () => {
    if (!parsed) {
      return (
        <div className="rounded-2xl border bg-white p-8 text-sm text-gray-600">
          Upload a raw Klaviyo campaign CSV export to generate the dashboard.
        </div>
      );
    }
    if (parsed.error) {
      return (
        <div className="rounded-2xl border bg-white p-8 text-sm text-red-700">
          {parsed.error}
        </div>
      );
    }

    switch (activeTab) {
      case "all_evergreen_latest":
        return <Table rows={tabData.evergreenLatest} />;
      case "all_sale_latest":
        return <Table rows={tabData.saleLatest} />;
      case "evergreen_monthly":
        return (
          <MonthlyBlocks
            map={tabData.evergreenByMonth}
            includeSummary={false}
          />
        );
      case "sale_monthly":
        return (
          <MonthlyBlocks map={tabData.saleByMonth} includeSummary={false} />
        );
      case "buyers_evergreen_monthly":
        return (
          <MonthlyBlocks
            map={tabData.buyersEvergreenMonthly}
            includeSummary={true}
          />
        );
      case "leads_evergreen_monthly":
        return (
          <MonthlyBlocks
            map={tabData.leadsEvergreenMonthly}
            includeSummary={true}
          />
        );
      case "sale_grouped":
        return <SaleGrouped />;
      case "totals_monthly":
        return <TotalsMonthly />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-7xl p-5 sm:p-8">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-gray-900">
                Email Performance Dashboard
              </div>
              <div className="text-sm text-gray-600">
                One raw CSV in. Executive-readable reporting out.
              </div>
            </div>
            <Controls />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Card
              title="Total revenue"
              value={formatMoney(globalKPIs.totalRevenue)}
            />
            <Card
              title="Evergreen revenue"
              value={formatMoney(globalKPIs.evergreenRevenue)}
            />
            <Card
              title="Sale revenue"
              value={formatMoney(globalKPIs.saleRevenue)}
              sub="Excludes hype"
            />
            <Card
              title="Avg revenue / email"
              value={formatMoney(globalKPIs.avgRevPerEmail)}
              sub={dedupeMode === "email" ? "Email view" : "By email (deduped)"}
            />
            <Card title="Open rate" value={formatPct(globalKPIs.openRate)} />
            <Card title="Click rate" value={formatPct(globalKPIs.clickRate)} />
          </div>

          <Charts />

          <MappingPreview />

          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3">
              <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
              <ActiveTabContent />
            </div>
          </div>

          <div className="text-xs text-gray-500">
            Classification rules: sale if name contains "sale", "special offer",
            or "launch". Hype if name contains "hype" (excluded from sale
            calculations).
          </div>
        </div>
      </div>
    </div>
  );
}

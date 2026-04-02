/**
 * Google Ads MCP Server - Cloud Version (SSE Transport)
 * Deploy to Railway, Render, Fly.io, etc.
 * Connect via claude.ai MCP integration
 */

import crypto from "crypto";
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleAdsApi } from "google-ads-api";

// ── Config (read at runtime, not build time) ─────────
const PORT = parseInt(process.env.PORT || "8765");

// Refresh token can be set via env var OR generated via /auth flow
let dynamicRefreshToken = null;

function getConfig() {
  const e = process.env;
  const CLIENT_ID = e.GOOGLE_ADS_CLIENT_ID;
  const CLIENT_SECRET = e.GOOGLE_ADS_CLIENT_SECRET;
  const DEV_TOKEN = e.GOOGLE_ADS_DEVELOPER_TOKEN;
  const REFRESH_TOKEN = dynamicRefreshToken || e.GOOGLE_ADS_REFRESH_TOKEN;
  const MCC_ID = (e.GOOGLE_ADS_MCC_ID || "").replace(/-/g, "");

  if (!CLIENT_ID || !CLIENT_SECRET || !DEV_TOKEN || !MCC_ID) {
    const missing = [];
    if (!CLIENT_ID) missing.push("GOOGLE_ADS_CLIENT_ID");
    if (!CLIENT_SECRET) missing.push("GOOGLE_ADS_CLIENT_SECRET");
    if (!DEV_TOKEN) missing.push("GOOGLE_ADS_DEVELOPER_TOKEN");
    if (!MCC_ID) missing.push("GOOGLE_ADS_MCC_ID");
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  if (!REFRESH_TOKEN) {
    return { CLIENT_ID, CLIENT_SECRET, DEV_TOKEN, REFRESH_TOKEN: null, MCC_ID, needsAuth: true };
  }

  return { CLIENT_ID, CLIENT_SECRET, DEV_TOKEN, REFRESH_TOKEN, MCC_ID, needsAuth: false };
}

let _config;
function config() {
  // Always re-read if we don't have refresh token yet
  if (!_config || _config.needsAuth) _config = getConfig();
  return _config;
}

let _api;
function getApi() {
  const c = config();
  // Recreate API if config changed (new refresh token)
  if (!_api) {
    _api = new GoogleAdsApi({ client_id: c.CLIENT_ID, client_secret: c.CLIENT_SECRET, developer_token: c.DEV_TOKEN });
  }
  return _api;
}

// ── OAuth Helper ─────────────────────────────────────
function getRedirectUri(host) {
  const proto = host.includes("localhost") ? "http" : "https";
  return `${proto}://${host}/callback`;
}

async function exchangeCodeForTokens(code, redirectUri) {
  const e = process.env;
  const body = new URLSearchParams({
    code,
    client_id: e.GOOGLE_ADS_CLIENT_ID,
    client_secret: e.GOOGLE_ADS_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  return await resp.json();
}

function cust(id) {
  const c = config();
  return getApi().Customer({ customer_id: (id || c.MCC_ID).replace(/-/g, ""), refresh_token: c.REFRESH_TOKEN, login_customer_id: c.MCC_ID });
}

async function q(customerId, query) {
  return await cust(customerId).query(query);
}

function dStr(d) { return d === 7 ? "7" : d === 14 ? "14" : "30"; }
function mic(v) { return Math.round(v * 1_000_000); }
function unmic(v) { return (Number(v || 0) / 1_000_000).toFixed(2); }
function pct(v) { return (Number(v || 0) * 100).toFixed(2) + "%"; }

// ══════════════════════════════════════════════════════
//  TOOL DEFINITIONS
// ══════════════════════════════════════════════════════

const t = (name, desc, props, req) => ({ name, description: desc, inputSchema: { type: "object", properties: props, required: req || [] } });
const pCid = { customer_id: { type: "string", description: "Google Ads account ID" } };
const pDays = { days: { type: "number", description: "Lookback: 7, 14, or 30 (default 30)", enum: [7, 14, 30] } };
const pCamp = { campaign_id: { type: "string", description: "Campaign ID" } };
const pAg = { ad_group_id: { type: "string", description: "Ad group ID" } };

const READ_TOOLS = [
  t("list_accounts", "List all Google Ads accounts under MCC", {}, []),
  t("list_campaigns", "List campaigns with status, type, budget", { ...pCid, status: { type: "string", enum: ["ENABLED", "PAUSED", "REMOVED"] } }, ["customer_id"]),
  t("campaign_performance", "Campaign metrics: impressions, clicks, CTR, cost, conversions, ROAS", { ...pCid, ...pDays, ...pCamp }, ["customer_id"]),
  t("ad_group_performance", "Ad group level metrics", { ...pCid, ...pDays, ...pCamp }, ["customer_id"]),
  t("keyword_performance", "Keyword metrics with match types", { ...pCid, ...pDays, ...pAg }, ["customer_id"]),
  t("ad_performance", "Individual ad level metrics", { ...pCid, ...pDays, ...pAg }, ["customer_id"]),
  t("search_terms_report", "Actual search queries triggering your ads", { ...pCid, ...pDays, ...pCamp }, ["customer_id"]),
  t("get_campaign_structure", "Full hierarchy: campaign -> ad groups -> keywords -> ads", { ...pCid, ...pCamp }, ["customer_id", "campaign_id"]),
  t("get_ad_group_ads", "All ads in an ad group with headlines, descriptions", { ...pCid, ...pAg }, ["customer_id", "ad_group_id"]),
  t("get_geo_performance", "Performance by location", { ...pCid, ...pDays, ...pCamp }, ["customer_id"]),
  t("get_device_performance", "Performance by device (mobile/desktop/tablet)", { ...pCid, ...pDays, ...pCamp }, ["customer_id"]),
  t("get_age_gender_performance", "Performance by age & gender demographics", { ...pCid, ...pDays, ...pCamp }, ["customer_id"]),
  t("get_quality_scores", "Keyword Quality Scores with component breakdown", { ...pCid, ...pCamp }, ["customer_id"]),
  t("get_conversion_actions", "All conversion actions in account", { ...pCid }, ["customer_id"]),
  t("get_campaign_budget_details", "Budget utilization & pacing", { ...pCid, ...pCamp }, ["customer_id"]),
  t("get_bidding_strategy_details", "Bidding strategy config per campaign", { ...pCid, ...pCamp }, ["customer_id"]),
  t("get_change_history", "Recent account changes audit", { ...pCid, ...pDays }, ["customer_id"]),
  t("run_gaql_query", "Run custom GAQL query", { ...pCid, query: { type: "string", description: "GAQL query" } }, ["customer_id", "query"]),
  t("get_location_targets", "Get current location targets (countries/cities) for a campaign", { ...pCid, ...pCamp }, ["customer_id", "campaign_id"]),
  t("search_geo_target", "Search for Google Ads geo target location IDs by name (country, city, state). Use this to find location criterion IDs before setting targets.", { ...pCid, location_name: { type: "string", description: "Location name to search (e.g. India, Mumbai, California)" } }, ["customer_id", "location_name"]),
];

const WRITE_TOOLS = [
  t("create_search_campaign", "Create Search campaign (PAUSED)", { ...pCid, name: { type: "string" }, daily_budget: { type: "number" }, target_cpa: { type: "number" }, target_roas: { type: "number" } }, ["customer_id", "name", "daily_budget"]),
  t("create_pmax_campaign", "Create Performance Max campaign (PAUSED)", { ...pCid, name: { type: "string" }, daily_budget: { type: "number" }, final_url: { type: "string" }, target_cpa: { type: "number" }, target_roas: { type: "number" } }, ["customer_id", "name", "daily_budget", "final_url"]),
  t("create_ad_group", "Create ad group in a campaign", { ...pCid, ...pCamp, name: { type: "string" }, cpc_bid: { type: "number" } }, ["customer_id", "campaign_id", "name"]),
  t("create_responsive_search_ad", "Create RSA (3-15 headlines, 2-4 descriptions)", { ...pCid, ...pAg, headlines: { type: "array", items: { type: "string" } }, descriptions: { type: "array", items: { type: "string" } }, final_urls: { type: "array", items: { type: "string" } }, path1: { type: "string" }, path2: { type: "string" } }, ["customer_id", "ad_group_id", "headlines", "descriptions", "final_urls"]),
  t("add_keywords", "Add keywords with match types to ad group", { ...pCid, ...pAg, keywords: { type: "array", items: { type: "object", properties: { text: { type: "string" }, match_type: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] } }, required: ["text", "match_type"] } } }, ["customer_id", "ad_group_id", "keywords"]),
  t("add_negative_keywords", "Add negative keywords to campaign", { ...pCid, ...pCamp, keywords: { type: "array", items: { type: "object", properties: { text: { type: "string" }, match_type: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] } }, required: ["text", "match_type"] } } }, ["customer_id", "campaign_id", "keywords"]),
  t("remove_keywords", "Delete keywords permanently", { ...pCid, keyword_resource_names: { type: "array", items: { type: "string" } } }, ["customer_id", "keyword_resource_names"]),
  t("remove_negative_keywords", "Remove negative keywords from campaign", { ...pCid, criterion_resource_names: { type: "array", items: { type: "string" } } }, ["customer_id", "criterion_resource_names"]),
  t("update_campaign_status", "Pause or enable campaign", { ...pCid, ...pCamp, status: { type: "string", enum: ["ENABLED", "PAUSED"] } }, ["customer_id", "campaign_id", "status"]),
  t("update_campaign_budget", "Change daily budget", { ...pCid, ...pCamp, daily_budget: { type: "number" } }, ["customer_id", "campaign_id", "daily_budget"]),
  t("update_campaign_name", "Rename campaign", { ...pCid, ...pCamp, new_name: { type: "string" } }, ["customer_id", "campaign_id", "new_name"]),
  t("update_bidding_strategy", "Change bidding strategy", { ...pCid, ...pCamp, strategy: { type: "string", enum: ["MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS", "TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE"] }, target_cpa: { type: "number" }, target_roas: { type: "number" }, max_cpc_ceiling: { type: "number" } }, ["customer_id", "campaign_id", "strategy"]),
  t("update_ad_group_status", "Pause or enable ad group", { ...pCid, ...pAg, status: { type: "string", enum: ["ENABLED", "PAUSED"] } }, ["customer_id", "ad_group_id", "status"]),
  t("update_ad_group_bid", "Update ad group CPC bid", { ...pCid, ...pAg, cpc_bid: { type: "number" } }, ["customer_id", "ad_group_id", "cpc_bid"]),
  t("update_keyword_status", "Pause or enable keyword", { ...pCid, ...pAg, criterion_id: { type: "string" }, status: { type: "string", enum: ["ENABLED", "PAUSED"] } }, ["customer_id", "ad_group_id", "criterion_id", "status"]),
  t("update_keyword_bid", "Update keyword CPC bid", { ...pCid, ...pAg, criterion_id: { type: "string" }, cpc_bid: { type: "number" } }, ["customer_id", "ad_group_id", "criterion_id", "cpc_bid"]),
  t("remove_ad", "Delete an ad", { ...pCid, ...pAg, ad_id: { type: "string" } }, ["customer_id", "ad_group_id", "ad_id"]),
  t("add_sitelinks", "Add sitelink extensions to campaign", { ...pCid, ...pCamp, sitelinks: { type: "array", items: { type: "object", properties: { text: { type: "string" }, final_url: { type: "string" }, description1: { type: "string" }, description2: { type: "string" } }, required: ["text", "final_url"] } } }, ["customer_id", "campaign_id", "sitelinks"]),
  t("set_location_targets", "Set target locations (countries/cities) for a campaign. Use search_geo_target first to find location IDs.", { ...pCid, ...pCamp, locations: { type: "array", description: "Array of location targets", items: { type: "object", properties: { location_id: { type: "string", description: "Geo target criterion ID (e.g. 2356 for India, 1007768 for Mumbai)" }, bid_modifier: { type: "number", description: "Bid adjustment multiplier (e.g. 1.2 for +20%, 0.8 for -20%). Optional." } }, required: ["location_id"] } } }, ["customer_id", "campaign_id", "locations"]),
  t("remove_location_targets", "Remove location targets from a campaign", { ...pCid, ...pCamp, criterion_ids: { type: "array", description: "Array of criterion IDs to remove", items: { type: "string" } } }, ["customer_id", "campaign_id", "criterion_ids"]),
];

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

// ══════════════════════════════════════════════════════
//  TOOL HANDLERS
// ══════════════════════════════════════════════════════

function aggPerf(data, type) {
  const m = new Map();
  for (const r of data) {
    const ent = type === "campaign" ? r.campaign : r.ad_group;
    const id = ent?.id?.toString(); if (!id) continue;
    if (!m.has(id)) m.set(id, { id, name: ent?.name, status: ent?.status, type: type === "campaign" ? ent?.advertising_channel_type : undefined, imp: 0, cli: 0, cost: 0, conv: 0, val: 0 });
    const a = m.get(id);
    a.imp += Number(r.metrics?.impressions || 0);
    a.cli += Number(r.metrics?.clicks || 0);
    a.cost += Number(r.metrics?.cost_micros || 0) / 1e6;
    a.conv += Number(r.metrics?.conversions || 0);
    a.val += Number(r.metrics?.conversions_value || 0);
  }
  return Array.from(m.values()).map(a => ({
    ...a, impressions: a.imp, clicks: a.cli, ctr: a.imp > 0 ? ((a.cli / a.imp) * 100).toFixed(2) + "%" : "0%",
    avg_cpc: a.cli > 0 ? (a.cost / a.cli).toFixed(2) : "0", cost: a.cost.toFixed(2),
    conversions: a.conv.toFixed(1), cpa: a.conv > 0 ? (a.cost / a.conv).toFixed(2) : "N/A",
    roas: a.cost > 0 ? (a.val / a.cost).toFixed(2) : "N/A",
  })).sort((a, b) => parseFloat(b.cost) - parseFloat(a.cost));
}

async function handle(name, a) {
  const cid = a.customer_id;
  const cleanId = (cid || "").replace(/-/g, "");
  const days = a.days || 30;
  const ds = dStr(days);
  const customer = cust(cid);

  switch (name) {
    case "list_accounts": {
      const r = await cust(config().MCC_ID).query(`SELECT customer_client.id, customer_client.descriptive_name, customer_client.status, customer_client.manager, customer_client.currency_code, customer_client.time_zone FROM customer_client WHERE customer_client.status = 'ENABLED' ORDER BY customer_client.descriptive_name`);
      return { total: r.length, accounts: r.map(x => ({ id: x.customer_client?.id?.toString(), name: x.customer_client?.descriptive_name, status: x.customer_client?.status, is_manager: x.customer_client?.manager, currency: x.customer_client?.currency_code, timezone: x.customer_client?.time_zone })) };
    }
    case "list_campaigns": {
      const r = await q(cid, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros FROM campaign ${a.status ? `WHERE campaign.status = '${a.status}'` : ""} ORDER BY campaign.name`);
      return { total: r.length, campaigns: r.map(x => ({ id: x.campaign?.id?.toString(), name: x.campaign?.name, status: x.campaign?.status, type: x.campaign?.advertising_channel_type, bidding: x.campaign?.bidding_strategy_type, daily_budget: x.campaign_budget?.amount_micros ? unmic(x.campaign_budget.amount_micros) : null })) };
    }
    case "campaign_performance": {
      const r = await q(cid, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value, segments.date FROM campaign WHERE segments.date DURING LAST_${ds}_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""} ORDER BY metrics.cost_micros DESC`);
      return { data: aggPerf(r, "campaign") };
    }
    case "ad_group_performance": {
      const r = await q(cid, `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, segments.date FROM ad_group WHERE segments.date DURING LAST_${ds}_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""} ORDER BY metrics.cost_micros DESC`);
      return { data: aggPerf(r, "ad_group") };
    }
    case "keyword_performance": {
      const r = await q(cid, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group.name, campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions FROM keyword_view WHERE segments.date DURING LAST_${ds}_DAYS ${a.ad_group_id ? `AND ad_group.id = ${a.ad_group_id}` : ""} ORDER BY metrics.impressions DESC LIMIT 100`);
      return { total: r.length, keywords: r.map(x => ({ keyword: x.ad_group_criterion?.keyword?.text, match_type: x.ad_group_criterion?.keyword?.match_type, status: x.ad_group_criterion?.status, ad_group: x.ad_group?.name, campaign: x.campaign?.name, impressions: Number(x.metrics?.impressions || 0), clicks: Number(x.metrics?.clicks || 0), ctr: pct(x.metrics?.ctr), avg_cpc: unmic(x.metrics?.average_cpc), cost: unmic(x.metrics?.cost_micros), conversions: Number(x.metrics?.conversions || 0) })) };
    }
    case "ad_performance": {
      const r = await q(cid, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group.name, campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE segments.date DURING LAST_${ds}_DAYS ${a.ad_group_id ? `AND ad_group.id = ${a.ad_group_id}` : ""} ORDER BY metrics.cost_micros DESC LIMIT 50`);
      return { total: r.length, ads: r.map(x => ({ ad_id: x.ad_group_ad?.ad?.id?.toString(), type: x.ad_group_ad?.ad?.type, status: x.ad_group_ad?.status, headlines: x.ad_group_ad?.ad?.responsive_search_ad?.headlines?.map(h => h.text) || [], descriptions: x.ad_group_ad?.ad?.responsive_search_ad?.descriptions?.map(d => d.text) || [], final_urls: x.ad_group_ad?.ad?.final_urls || [], ad_group: x.ad_group?.name, campaign: x.campaign?.name, impressions: Number(x.metrics?.impressions || 0), clicks: Number(x.metrics?.clicks || 0), ctr: pct(x.metrics?.ctr), cost: unmic(x.metrics?.cost_micros), conversions: Number(x.metrics?.conversions || 0) })) };
    }
    case "search_terms_report": {
      const r = await q(cid, `SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_${ds}_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""} ORDER BY metrics.impressions DESC LIMIT 100`);
      return { total: r.length, search_terms: r.map(x => ({ search_term: x.search_term_view?.search_term, status: x.search_term_view?.status, campaign: x.campaign?.name, ad_group: x.ad_group?.name, impressions: Number(x.metrics?.impressions || 0), clicks: Number(x.metrics?.clicks || 0), ctr: pct(x.metrics?.ctr), cost: unmic(x.metrics?.cost_micros), conversions: Number(x.metrics?.conversions || 0) })) };
    }
    case "get_campaign_structure": {
      const ags = await q(cid, `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${a.campaign_id}`);
      const kws = await q(cid, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group.id FROM keyword_view WHERE campaign.id = ${a.campaign_id} LIMIT 200`);
      const ads = await q(cid, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group.id FROM ad_group_ad WHERE campaign.id = ${a.campaign_id}`);
      return { campaign_id: a.campaign_id, ad_groups: ags.map(ag => { const agId = ag.ad_group?.id?.toString(); return { id: agId, name: ag.ad_group?.name, status: ag.ad_group?.status, keywords: kws.filter(k => k.ad_group?.id?.toString() === agId).map(k => ({ text: k.ad_group_criterion?.keyword?.text, match_type: k.ad_group_criterion?.keyword?.match_type, status: k.ad_group_criterion?.status })), ads: ads.filter(x => x.ad_group?.id?.toString() === agId).map(x => ({ id: x.ad_group_ad?.ad?.id?.toString(), status: x.ad_group_ad?.status, headlines: x.ad_group_ad?.ad?.responsive_search_ad?.headlines?.map(h => h.text) || [], descriptions: x.ad_group_ad?.ad?.responsive_search_ad?.descriptions?.map(d => d.text) || [], final_urls: x.ad_group_ad?.ad?.final_urls || [] })) }; }) };
    }
    case "get_ad_group_ads": {
      const r = await q(cid, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group_ad.ad.strength FROM ad_group_ad WHERE ad_group.id = ${a.ad_group_id}`);
      return { total: r.length, ads: r.map(x => ({ id: x.ad_group_ad?.ad?.id?.toString(), type: x.ad_group_ad?.ad?.type, status: x.ad_group_ad?.status, strength: x.ad_group_ad?.ad?.strength, headlines: x.ad_group_ad?.ad?.responsive_search_ad?.headlines?.map(h => h.text) || [], descriptions: x.ad_group_ad?.ad?.responsive_search_ad?.descriptions?.map(d => d.text) || [], final_urls: x.ad_group_ad?.ad?.final_urls || [] })) };
    }
    case "get_geo_performance": {
      const r = await q(cid, `SELECT geographic_view.country_criterion_id, geographic_view.location_type, campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions FROM geographic_view WHERE segments.date DURING LAST_${ds}_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""} ORDER BY metrics.cost_micros DESC LIMIT 50`);
      return { locations: r.map(x => ({ location_id: x.geographic_view?.country_criterion_id?.toString(), type: x.geographic_view?.location_type, campaign: x.campaign?.name, impressions: Number(x.metrics?.impressions || 0), clicks: Number(x.metrics?.clicks || 0), ctr: pct(x.metrics?.ctr), cost: unmic(x.metrics?.cost_micros), conversions: Number(x.metrics?.conversions || 0) })) };
    }
    case "get_device_performance": {
      const r = await q(cid, `SELECT segments.device, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_${ds}_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""}`);
      const dm = new Map();
      for (const x of r) { const d = x.segments?.device || "UNKNOWN"; if (!dm.has(d)) dm.set(d, { device: d, impressions: 0, clicks: 0, cost: 0, conversions: 0 }); const v = dm.get(d); v.impressions += Number(x.metrics?.impressions || 0); v.clicks += Number(x.metrics?.clicks || 0); v.cost += Number(x.metrics?.cost_micros || 0) / 1e6; v.conversions += Number(x.metrics?.conversions || 0); }
      return { devices: Array.from(dm.values()).map(d => ({ ...d, ctr: d.impressions > 0 ? ((d.clicks / d.impressions) * 100).toFixed(2) + "%" : "0%", avg_cpc: d.clicks > 0 ? (d.cost / d.clicks).toFixed(2) : "0", cost: d.cost.toFixed(2) })) };
    }
    case "get_age_gender_performance": {
      const age = await q(cid, `SELECT ad_group_criterion.age_range.type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM age_range_view WHERE segments.date DURING LAST_${ds}_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""}`);
      const gen = await q(cid, `SELECT ad_group_criterion.gender.type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM gender_view WHERE segments.date DURING LAST_${ds}_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""}`);
      const aggDemo = (data, key) => { const m = new Map(); for (const x of data) { const k = key === "age" ? x.ad_group_criterion?.age_range?.type : x.ad_group_criterion?.gender?.type; if (!k) continue; if (!m.has(k)) m.set(k, { [key]: k, impressions: 0, clicks: 0, cost: 0, conversions: 0 }); const v = m.get(k); v.impressions += Number(x.metrics?.impressions || 0); v.clicks += Number(x.metrics?.clicks || 0); v.cost += Number(x.metrics?.cost_micros || 0) / 1e6; v.conversions += Number(x.metrics?.conversions || 0); } return Array.from(m.values()).map(d => ({ ...d, ctr: d.impressions > 0 ? ((d.clicks / d.impressions) * 100).toFixed(2) + "%" : "0%", cost: d.cost.toFixed(2) })); };
      return { age_ranges: aggDemo(age, "age"), genders: aggDemo(gen, "gender") };
    }
    case "get_quality_scores": {
      const r = await q(cid, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr, ad_group.name, campaign.name FROM keyword_view ${a.campaign_id ? `WHERE campaign.id = ${a.campaign_id}` : ""} ORDER BY ad_group_criterion.quality_info.quality_score ASC LIMIT 100`);
      return { total: r.length, keywords: r.map(x => ({ keyword: x.ad_group_criterion?.keyword?.text, match_type: x.ad_group_criterion?.keyword?.match_type, quality_score: x.ad_group_criterion?.quality_info?.quality_score, expected_ctr: x.ad_group_criterion?.quality_info?.search_predicted_ctr, ad_relevance: x.ad_group_criterion?.quality_info?.creative_quality_score, landing_page: x.ad_group_criterion?.quality_info?.post_click_quality_score, ad_group: x.ad_group?.name, campaign: x.campaign?.name })) };
    }
    case "get_conversion_actions": {
      const r = await q(cid, `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status, conversion_action.category FROM conversion_action ORDER BY conversion_action.name`);
      return { total: r.length, actions: r.map(x => ({ id: x.conversion_action?.id?.toString(), name: x.conversion_action?.name, type: x.conversion_action?.type, status: x.conversion_action?.status, category: x.conversion_action?.category })) };
    }
    case "get_campaign_budget_details": {
      const r = await q(cid, `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.delivery_method, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""}`);
      const bm = new Map();
      for (const x of r) { const id = x.campaign?.id?.toString(); if (!id) continue; if (!bm.has(id)) bm.set(id, { id, name: x.campaign?.name, status: x.campaign?.status, daily_budget: unmic(x.campaign_budget?.amount_micros), delivery: x.campaign_budget?.delivery_method, spent_30d: 0 }); bm.get(id).spent_30d += Number(x.metrics?.cost_micros || 0) / 1e6; }
      return { campaigns: Array.from(bm.values()).map(b => ({ ...b, spent_30d: b.spent_30d.toFixed(2), daily_avg: (b.spent_30d / 30).toFixed(2), utilization: parseFloat(b.daily_budget) > 0 ? ((b.spent_30d / 30 / parseFloat(b.daily_budget)) * 100).toFixed(1) + "%" : "N/A" })) };
    }
    case "get_bidding_strategy_details": {
      const r = await q(cid, `SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_clicks.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas FROM campaign WHERE campaign.status != 'REMOVED' ${a.campaign_id ? `AND campaign.id = ${a.campaign_id}` : ""}`);
      return { campaigns: r.map(x => ({ id: x.campaign?.id?.toString(), name: x.campaign?.name, strategy: x.campaign?.bidding_strategy_type, target_cpa: x.campaign?.target_cpa?.target_cpa_micros ? unmic(x.campaign.target_cpa.target_cpa_micros) : x.campaign?.maximize_conversions?.target_cpa_micros ? unmic(x.campaign.maximize_conversions.target_cpa_micros) : null, target_roas: x.campaign?.target_roas?.target_roas || x.campaign?.maximize_conversion_value?.target_roas || null, max_cpc_ceiling: x.campaign?.maximize_clicks?.cpc_bid_ceiling_micros ? unmic(x.campaign.maximize_clicks.cpc_bid_ceiling_micros) : null })) };
    }
    case "get_change_history": {
      const r = await q(cid, `SELECT change_event.change_date_time, change_event.change_resource_type, change_event.resource_change_operation, change_event.user_email, change_event.changed_fields, campaign.name, ad_group.name FROM change_event WHERE change_event.change_date_time DURING LAST_${dStr(a.days || 7)}_DAYS ORDER BY change_event.change_date_time DESC LIMIT 50`);
      return { total: r.length, changes: r.map(x => ({ date: x.change_event?.change_date_time, type: x.change_event?.change_resource_type, operation: x.change_event?.resource_change_operation, user: x.change_event?.user_email, fields: x.change_event?.changed_fields, campaign: x.campaign?.name, ad_group: x.ad_group?.name })) };
    }
    case "run_gaql_query": {
      const r = await q(cid, a.query);
      return { total: r.length, results: r };
    }
    case "get_location_targets": {
      const r = await q(cid, `SELECT campaign_criterion.criterion_id, campaign_criterion.location.geo_target_constant, campaign_criterion.bid_modifier, campaign_criterion.negative FROM campaign_criterion WHERE campaign.id = ${a.campaign_id} AND campaign_criterion.type = 'LOCATION'`);
      const locations = [];
      for (const x of r) {
        const geoConstant = x.campaign_criterion?.location?.geo_target_constant;
        let locInfo = { criterion_id: x.campaign_criterion?.criterion_id?.toString(), geo_target: geoConstant, bid_modifier: x.campaign_criterion?.bid_modifier, negative: x.campaign_criterion?.negative };
        if (geoConstant) {
          try {
            const geo = await q(cid, `SELECT geo_target_constant.name, geo_target_constant.country_code, geo_target_constant.target_type, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.resource_name = '${geoConstant}'`);
            if (geo.length) {
              locInfo.name = geo[0].geo_target_constant?.name;
              locInfo.country_code = geo[0].geo_target_constant?.country_code;
              locInfo.type = geo[0].geo_target_constant?.target_type;
              locInfo.full_name = geo[0].geo_target_constant?.canonical_name;
            }
          } catch (e) { /* geo lookup failed, skip */ }
        }
        locations.push(locInfo);
      }
      return { campaign_id: a.campaign_id, total: locations.length, locations };
    }
    case "search_geo_target": {
      const r = await q(cid, `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code, geo_target_constant.target_type, geo_target_constant.canonical_name, geo_target_constant.status FROM geo_target_constant WHERE geo_target_constant.name LIKE '%${a.location_name}%' AND geo_target_constant.status = 'ENABLED' LIMIT 20`);
      return { total: r.length, locations: r.map(x => ({ id: x.geo_target_constant?.id?.toString(), name: x.geo_target_constant?.name, country_code: x.geo_target_constant?.country_code, type: x.geo_target_constant?.target_type, full_name: x.geo_target_constant?.canonical_name })) };
    }
    case "create_search_campaign": {
      const bud = await customer.campaignBudgets.create([{ name: `${a.name} Budget`, amount_micros: mic(a.daily_budget), delivery_method: "STANDARD" }]);
      const cfg = { name: a.name, status: "PAUSED", advertising_channel_type: "SEARCH", campaign_budget: bud.results[0].resource_name, network_settings: { target_google_search: true, target_search_network: true, target_content_network: false } };
      if (a.target_cpa) cfg.target_cpa = { target_cpa_micros: mic(a.target_cpa) };
      else if (a.target_roas) cfg.target_roas = { target_roas: a.target_roas };
      else cfg.maximize_clicks = {};
      const r = await customer.campaigns.create([cfg]);
      return { success: true, message: `Search campaign "${a.name}" created (PAUSED)`, result: r };
    }
    case "create_pmax_campaign": {
      const bud = await customer.campaignBudgets.create([{ name: `${a.name} Budget`, amount_micros: mic(a.daily_budget), delivery_method: "STANDARD" }]);
      const cfg = { name: a.name, status: "PAUSED", advertising_channel_type: "PERFORMANCE_MAX", campaign_budget: bud.results[0].resource_name, url_expansion_opt_out: false };
      if (a.target_cpa) cfg.maximize_conversions = { target_cpa_micros: mic(a.target_cpa) };
      else if (a.target_roas) cfg.maximize_conversion_value = { target_roas: a.target_roas };
      else cfg.maximize_conversions = {};
      const r = await customer.campaigns.create([cfg]);
      return { success: true, message: `PMax campaign "${a.name}" created (PAUSED)`, result: r };
    }
    case "create_ad_group": {
      const r = await customer.adGroups.create([{ name: a.name, campaign: `customers/${cleanId}/campaigns/${a.campaign_id}`, status: "ENABLED", type: "SEARCH_STANDARD", cpc_bid_micros: a.cpc_bid ? mic(a.cpc_bid) : 1_000_000 }]);
      return { success: true, message: `Ad group "${a.name}" created`, result: r };
    }
    case "create_responsive_search_ad": {
      if (a.headlines.length < 3 || a.headlines.length > 15) throw new Error("Need 3-15 headlines");
      if (a.descriptions.length < 2 || a.descriptions.length > 4) throw new Error("Need 2-4 descriptions");
      const r = await customer.ads.create([{ ad_group: `customers/${cleanId}/adGroups/${a.ad_group_id}`, status: "ENABLED", ad: { responsive_search_ad: { headlines: a.headlines.map(h => ({ text: h })), descriptions: a.descriptions.map(d => ({ text: d })), path1: a.path1 || "", path2: a.path2 || "" }, final_urls: a.final_urls } }]);
      return { success: true, message: "RSA created", result: r };
    }
    case "add_keywords": {
      const r = await customer.adGroupCriteria.create(a.keywords.map(k => ({ ad_group: `customers/${cleanId}/adGroups/${a.ad_group_id}`, keyword: { text: k.text, match_type: k.match_type }, status: "ENABLED" })));
      return { success: true, message: `${a.keywords.length} keywords added`, result: r };
    }
    case "add_negative_keywords": {
      const r = await customer.campaignCriteria.create(a.keywords.map(k => ({ campaign: `customers/${cleanId}/campaigns/${a.campaign_id}`, keyword: { text: k.text, match_type: k.match_type }, negative: true })));
      return { success: true, message: `${a.keywords.length} negative keywords added`, result: r };
    }
    case "remove_keywords": {
      const r = await customer.adGroupCriteria.remove(a.keyword_resource_names);
      return { success: true, message: `${a.keyword_resource_names.length} keywords removed`, result: r };
    }
    case "remove_negative_keywords": {
      const r = await customer.campaignCriteria.remove(a.criterion_resource_names);
      return { success: true, message: `${a.criterion_resource_names.length} negative keywords removed`, result: r };
    }
    case "update_campaign_status": {
      const r = await customer.campaigns.update([{ resource_name: `customers/${cleanId}/campaigns/${a.campaign_id}`, status: a.status }]);
      return { success: true, message: `Campaign -> ${a.status}`, result: r };
    }
    case "update_campaign_budget": {
      const camps = await q(cid, `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${a.campaign_id}`);
      if (!camps.length) throw new Error("Campaign not found");
      const r = await customer.campaignBudgets.update([{ resource_name: camps[0].campaign?.campaign_budget, amount_micros: mic(a.daily_budget) }]);
      return { success: true, message: `Budget -> ${a.daily_budget}/day`, result: r };
    }
    case "update_campaign_name": {
      const r = await customer.campaigns.update([{ resource_name: `customers/${cleanId}/campaigns/${a.campaign_id}`, name: a.new_name }]);
      return { success: true, message: `Renamed to "${a.new_name}"`, result: r };
    }
    case "update_bidding_strategy": {
      const u = { resource_name: `customers/${cleanId}/campaigns/${a.campaign_id}` };
      if (a.strategy === "MAXIMIZE_CLICKS") u.maximize_clicks = a.max_cpc_ceiling ? { cpc_bid_ceiling_micros: mic(a.max_cpc_ceiling) } : {};
      else if (a.strategy === "MAXIMIZE_CONVERSIONS") u.maximize_conversions = a.target_cpa ? { target_cpa_micros: mic(a.target_cpa) } : {};
      else if (a.strategy === "TARGET_CPA") { if (!a.target_cpa) throw new Error("target_cpa required"); u.target_cpa = { target_cpa_micros: mic(a.target_cpa) }; }
      else if (a.strategy === "TARGET_ROAS") { if (!a.target_roas) throw new Error("target_roas required"); u.target_roas = { target_roas: a.target_roas }; }
      else if (a.strategy === "MAXIMIZE_CONVERSION_VALUE") u.maximize_conversion_value = a.target_roas ? { target_roas: a.target_roas } : {};
      const r = await customer.campaigns.update([u]);
      return { success: true, message: `Bidding -> ${a.strategy}`, result: r };
    }
    case "update_ad_group_status": {
      const r = await customer.adGroups.update([{ resource_name: `customers/${cleanId}/adGroups/${a.ad_group_id}`, status: a.status }]);
      return { success: true, message: `Ad group -> ${a.status}`, result: r };
    }
    case "update_ad_group_bid": {
      const r = await customer.adGroups.update([{ resource_name: `customers/${cleanId}/adGroups/${a.ad_group_id}`, cpc_bid_micros: mic(a.cpc_bid) }]);
      return { success: true, message: `Ad group CPC -> ${a.cpc_bid}`, result: r };
    }
    case "update_keyword_status": {
      const r = await customer.adGroupCriteria.update([{ resource_name: `customers/${cleanId}/adGroups/${a.ad_group_id}/criteria/${a.criterion_id}`, status: a.status }]);
      return { success: true, message: `Keyword -> ${a.status}`, result: r };
    }
    case "update_keyword_bid": {
      const r = await customer.adGroupCriteria.update([{ resource_name: `customers/${cleanId}/adGroups/${a.ad_group_id}/criteria/${a.criterion_id}`, cpc_bid_micros: mic(a.cpc_bid) }]);
      return { success: true, message: `Keyword CPC -> ${a.cpc_bid}`, result: r };
    }
    case "remove_ad": {
      const r = await customer.ads.remove([`customers/${cleanId}/adGroupAds/${a.ad_group_id}~${a.ad_id}`]);
      return { success: true, message: `Ad removed`, result: r };
    }
    case "set_location_targets": {
      const r = await customer.campaignCriteria.create(a.locations.map(loc => {
        const criteria = {
          campaign: `customers/${cleanId}/campaigns/${a.campaign_id}`,
          location: { geo_target_constant: `geoTargetConstants/${loc.location_id}` }
        };
        if (loc.bid_modifier) criteria.bid_modifier = loc.bid_modifier;
        return criteria;
      }));
      return { success: true, message: `${a.locations.length} location targets added`, result: r };
    }
    case "remove_location_targets": {
      const r = await customer.campaignCriteria.remove(a.criterion_ids.map(id => `customers/${cleanId}/campaignCriteria/${a.campaign_id}~${id}`));
      return { success: true, message: `${a.criterion_ids.length} location targets removed`, result: r };
    }
    case "add_sitelinks": {
      const assets = await customer.assets.create(a.sitelinks.map(s => ({ sitelink_asset: { link_text: s.text, description1: s.description1 || "", description2: s.description2 || "" }, final_urls: [s.final_url] })));
      const r = await customer.campaignAssets.create(assets.results.map(x => ({ campaign: `customers/${cleanId}/campaigns/${a.campaign_id}`, asset: x.resource_name, field_type: "SITELINK" })));
      return { success: true, message: `${a.sitelinks.length} sitelinks added`, result: r };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ══════════════════════════════════════════════════════
//  MCP SERVER (SSE + Streamable HTTP)
// ══════════════════════════════════════════════════════

function setupHandlers(srv) {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const r = await handle(req.params.name, req.params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true };
    }
  });
  return srv;
}

// Track active SSE transports
const sseTransports = new Map();
// Track active Streamable HTTP transports
const streamTransports = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  // CORS headers for claude.ai
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === "/health") {
    const c = config();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", tools: ALL_TOOLS.length, sse_sessions: sseTransports.size, stream_sessions: streamTransports.size, auth: !c.needsAuth ? "connected" : "needs_auth - visit /auth" }));
    return;
  }

  // ── OAuth: Step 1 - Redirect to Google ──────────────
  if (url.pathname === "/auth") {
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    if (!clientId) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end("<h2>Set GOOGLE_ADS_CLIENT_ID env var first</h2>");
      return;
    }
    const redirectUri = getRedirectUri(req.headers.host);
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── OAuth: Step 2 - Handle callback ─────────────────
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<h2>Auth failed: ${error}</h2><p><a href="/auth">Try again</a></p>`);
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h2>No code received</h2><p><a href='/auth'>Try again</a></p>");
      return;
    }

    try {
      const redirectUri = getRedirectUri(req.headers.host);
      const tokens = await exchangeCodeForTokens(code, redirectUri);

      if (tokens.error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h2>Token error: ${tokens.error}</h2><p>${tokens.error_description || ""}</p><p><a href="/auth">Try again</a></p>`);
        return;
      }

      if (tokens.refresh_token) {
        dynamicRefreshToken = tokens.refresh_token;
        _config = null;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <h2>Google Ads MCP Server - Connected!</h2>
          <p>Refresh token generated and active. Server is ready to use.</p>
          <h3>For permanent setup, add this env var to Railway:</h3>
          <pre style="background:#f0f0f0;padding:15px;border-radius:8px;word-break:break-all;max-width:800px;">GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}</pre>
          <p><b>Next step:</b> Add MCP server URL in claude.ai:</p>
          <pre style="background:#f0f0f0;padding:15px;border-radius:8px;">https://${req.headers.host}/sse</pre>
          <p><a href="/health">Check health</a></p>
        `);
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h2>No refresh token received</h2><p>Google didn't return a refresh token. This happens if you already authorized before.</p><p><a href="/auth">Try again</a> (will force re-consent)</p>`);
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(`<h2>Error: ${err.message}</h2><p><a href="/auth">Try again</a></p>`);
    }
    return;
  }

  // ── Streamable HTTP endpoint ─────────────────────────
  if (url.pathname === "/mcp") {
    const c = config();
    if (c.needsAuth) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not authenticated. Visit /auth first." }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];

    if (req.method === "POST") {
      // Existing session
      if (sessionId && streamTransports.has(sessionId)) {
        await streamTransports.get(sessionId).handleRequest(req, res);
        return;
      }

      // New session
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      const server = new Server({ name: "google-ads-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      setupHandlers(server);
      await server.connect(transport);

      // handleRequest will assign sessionId on first InitializeRequest
      await transport.handleRequest(req, res);

      // Now store the transport with its assigned sessionId
      if (transport.sessionId) {
        streamTransports.set(transport.sessionId, transport);
        transport.onclose = () => {
          streamTransports.delete(transport.sessionId);
          server.close();
        };
      }
      return;
    }

    if (req.method === "GET") {
      if (sessionId && streamTransports.has(sessionId)) {
        await streamTransports.get(sessionId).handleRequest(req, res);
        return;
      }
      res.writeHead(405);
      res.end("Method Not Allowed - POST to initialize first");
      return;
    }

    if (req.method === "DELETE") {
      if (sessionId && streamTransports.has(sessionId)) {
        const transport = streamTransports.get(sessionId);
        await transport.handleRequest(req, res);
        streamTransports.delete(sessionId);
        return;
      }
      res.writeHead(404);
      res.end("Session not found");
      return;
    }

    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  // ── SSE endpoint (legacy, also works) ───────────────
  if (url.pathname === "/sse") {
    const c = config();
    if (c.needsAuth) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not authenticated. Visit /auth first." }));
      return;
    }

    const transport = new SSEServerTransport("/messages", res);
    const server = new Server({ name: "google-ads-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    setupHandlers(server);

    sseTransports.set(transport.sessionId, { transport, server });

    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
    });

    await server.connect(transport);
    return;
  }

  // Messages endpoint for SSE
  if (url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId");
    const session = sseTransports.get(sessionId);

    if (!session) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired session" }));
      return;
    }

    await session.transport.handlePostMessage(req, res);
    return;
  }

  // Root - info page
  if (url.pathname === "/") {
    const hasRefresh = !!(dynamicRefreshToken || process.env.GOOGLE_ADS_REFRESH_TOKEN);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <h2>Google Ads MCP Server</h2>
      <p><b>Status:</b> ${hasRefresh ? "Ready" : "Needs auth - <a href='/auth'>Click here to connect Google Ads</a>"}</p>
      <p><b>Tools:</b> ${ALL_TOOLS.length}</p>
      <h3>Connect to claude.ai:</h3>
      <p>Use any of these URLs:</p>
      <ul>
        <li><code>https://${req.headers.host}/mcp</code> (Streamable HTTP - recommended)</li>
        <li><code>https://${req.headers.host}/sse</code> (SSE - legacy)</li>
      </ul>
      <h3>Other endpoints:</h3>
      <ul>
        <li><a href="/auth">/auth</a> - Connect Google Ads account</li>
        <li><a href="/health">/health</a> - Health check</li>
      </ul>
    `);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`Google Ads MCP Server running on port ${PORT}`);
  console.log(`Streamable HTTP: http://localhost:${PORT}/mcp`);
  console.log(`SSE endpoint:    http://localhost:${PORT}/sse`);
  console.log(`Health check:    http://localhost:${PORT}/health`);
});

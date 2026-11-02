/** LinkedIn Advertising API: account discovery and campaign-group reporting. */
import { linkedInApiVersion } from "@/lib/integrations/linkedin/config";
import { LINKEDIN_GROUP_PREFIX, type AdSpendRow } from "@/lib/marketing/ad-platforms";

const API = "https://api.linkedin.com/rest";
const TIMEOUT_MS = 20_000;

export class LinkedInAdsApiError extends Error {}
export interface LinkedInAdAccount { id: string; name: string; currency: string; active: boolean }

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "LinkedIn-Version": linkedInApiVersion(), "X-Restli-Protocol-Version": "2.0.0" };
}

async function getJson(path: string, token: string): Promise<Record<string, unknown>> {
  let res: Response;
  try { res = await fetch(`${API}${path}`, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw new LinkedInAdsApiError("Could not reach LinkedIn Ads. Try again."); }
  if (!res.ok) {
    if (res.status === 401) throw new LinkedInAdsApiError("LinkedIn Ads access expired. Reconnect LinkedIn Ads.");
    if (res.status === 403) throw new LinkedInAdsApiError("LinkedIn denied Ads access. Advertising API approval and an Ad Account role are required.");
    throw new LinkedInAdsApiError("LinkedIn Ads could not load data. Try again.");
  }
  return res.json() as Promise<Record<string, unknown>>;
}

/** Accounts the authorised LinkedIn member may read. */
export async function listLinkedInAdAccounts(token: string): Promise<LinkedInAdAccount[]> {
  const rows = await searchPages("/adAccounts?q=search&pageSize=1000", token);
  return rows.flatMap((row) => {
    const id = row.id == null ? "" : String(row.id);
    if (!id) return [];
    return [{ id, name: typeof row.name === "string" ? row.name : `LinkedIn account ${id}`,
      currency: typeof row.currency === "string" ? row.currency : "INR", active: row.status === "ACTIVE" }];
  });
}

const urnId = (v: unknown) => String(v ?? "").split(":").at(-1) ?? "";

async function searchPages(path: string, token: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let next: string | undefined;
  do {
    const body = await getJson(`${path}${next ? `&pageToken=${encodeURIComponent(next)}` : ""}`, token);
    rows.push(...(Array.isArray(body.elements) ? body.elements as Record<string, unknown>[] : []));
    const metadata = body.metadata as { nextPageToken?: unknown } | undefined;
    next = typeof metadata?.nextPageToken === "string" ? metadata.nextPageToken : undefined;
    if (next && seen.has(next)) throw new LinkedInAdsApiError("LinkedIn Ads pagination repeated. Try again.");
    if (next) seen.add(next);
  } while (next);
  return rows;
}

async function listCampaignGroups(token: string, accountId: string): Promise<Map<string, string>> {
  const statuses = "ACTIVE,ARCHIVED,CANCELED,DRAFT,PAUSED,PENDING_DELETION,REMOVED";
  const rows = await searchPages(`/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups?q=search&search=(status:(values:List(${statuses})))&pageSize=1000`, token);
  const groups = rows.flatMap((row) => {
    const id = row.id == null ? "" : String(row.id);
    return id ? [{ id, name: typeof row.name === "string" ? row.name : id }] : [];
  });
  return new Map(groups.map((g) => [g.id, g.name]));
}

const datePart = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number);
  return `(year:${year},month:${month},day:${day})`;
};

/** Campaign groups are LinkedIn's top-level ad campaigns (above its ad-set-like campaigns). */
export async function fetchLinkedInCampaignSpend(token: string, accountId: string, from: string, to: string, internalAccountId: string, granularity: "DAILY" | "MONTHLY" = "DAILY"): Promise<AdSpendRow[]> {
  const [groups, body] = await Promise.all([
    listCampaignGroups(token, accountId),
    getJson(`/adAnalytics?q=statistics&pivots=List(CAMPAIGN_GROUP)&accounts=List(urn%3Ali%3AsponsoredAccount%3A${encodeURIComponent(accountId)})&dateRange=(start:${datePart(from)},end:${datePart(to)})&timeGranularity=${granularity}&fields=dateRange,pivotValues,impressions,clicks,costInLocalCurrency,externalWebsiteConversions`, token),
  ]);
  const rows = Array.isArray(body.elements) ? body.elements as Record<string, unknown>[] : [];
  return rows.flatMap((row) => {
    const groupId = urnId(Array.isArray(row.pivotValues) ? row.pivotValues[0] : row.campaignGroup);
    const range = row.dateRange as { start?: { year?: number; month?: number; day?: number } } | undefined;
    const d = range?.start;
    if (!groupId || !d?.year || !d.month || !d.day) return [];
    const day = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    return [{ platform: "linkedin-ads" as const, account_id: internalAccountId, day, campaign_id: `${LINKEDIN_GROUP_PREFIX}${groupId}`,
      campaign_name: groups.get(groupId) ?? `Campaign group ${groupId}`, spend: Number(row.costInLocalCurrency) || 0,
      impressions: Math.round(Number(row.impressions) || 0), clicks: Math.round(Number(row.clicks) || 0),
      conversions: Number(row.externalWebsiteConversions) || 0, conversion_value: 0 }];
  });
}

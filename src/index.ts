import { fetchProviderStatus } from "./providers";
import type { CachedSnapshot, ChannelRequest, Env, LiveChannelResult, ProviderName } from "./types";

const SERVICE_NAME = "heimdall";
const DEFAULT_MAX_CHANNELS = 12;
const MAX_CHANNEL_SPEC_LENGTH = 160;
const SNAPSHOT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const SUPPORTED_PROVIDERS = new Set<ProviderName>(["twitch", "youtube", "tiktok", "kick"]);

const jsonObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const parsePositiveInteger = (value: string | undefined, fallback: number, max: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const maxChannels = (env: Env): number => parsePositiveInteger(env.MAX_CHANNELS, DEFAULT_MAX_CHANNELS, 30);

const cacheTtl = (env: Env): number => parsePositiveInteger(env.CACHE_TTL_SECONDS, 30, 300);

const cleanChannel = (provider: ProviderName, value: string): string | undefined => {
  const channel = value.trim().replace(/^@/, "");
  if (!channel || channel.length > MAX_CHANNEL_SPEC_LENGTH) return undefined;
  if (provider === "twitch") return /^[a-z0-9_]{1,25}$/i.test(channel) ? channel.toLowerCase() : undefined;
  if (provider === "youtube") return /^UC[a-zA-Z0-9_-]{22}$/.test(channel) ? channel : undefined;
  if (provider === "kick") return /^[a-z0-9_-]{1,25}$/i.test(channel) ? channel.toLowerCase() : undefined;
  return /^[a-z0-9._]{1,24}$/i.test(channel) ? channel.toLowerCase() : undefined;
};

const parseSpec = (raw: string, defaultProvider?: string): ChannelRequest | undefined => {
  const value = raw.trim();
  if (!value || value.length > MAX_CHANNEL_SPEC_LENGTH) return undefined;
  const separator = value.indexOf(":");
  const providerValue = separator >= 0 ? value.slice(0, separator) : defaultProvider;
  const channelValue = separator >= 0 ? value.slice(separator + 1) : value;
  if (!providerValue || !SUPPORTED_PROVIDERS.has(providerValue.toLowerCase() as ProviderName)) return undefined;
  const provider = providerValue.toLowerCase() as ProviderName;
  const channel = cleanChannel(provider, channelValue);
  if (!channel) return undefined;
  return { provider, channel, key: `${provider}:${channel}` };
};

const parseSpecs = (values: string[], defaultProvider: string | undefined, limit: number): { channels?: ChannelRequest[]; error?: string } => {
  const rawValues = values.flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
  if (rawValues.length === 0) return { error: "missing_channels" };

  const channels: ChannelRequest[] = [];
  const keys = new Set<string>();
  for (const raw of rawValues) {
    const channel = parseSpec(raw, defaultProvider);
    if (!channel) return { error: "invalid_channel_spec" };
    if (keys.has(channel.key)) continue;
    if (channels.length >= limit) return { error: "too_many_channels" };
    keys.add(channel.key);
    channels.push(channel);
  }
  return channels.length > 0 ? { channels } : { error: "missing_channels" };
};

const allowedOrigins = (env: Env): string[] => (env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);

const corsHeaders = (request: Request, env: Env): Headers => {
  const headers = new Headers({
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
    vary: "Origin",
    "x-content-type-options": "nosniff",
  });
  const origin = request.headers.get("Origin");
  const origins = allowedOrigins(env);
  if (origins.includes("*")) headers.set("access-control-allow-origin", "*");
  else if (origin && origins.includes(origin)) headers.set("access-control-allow-origin", origin);
  return headers;
};

const isAllowedOrigin = (request: Request, env: Env): boolean => {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).includes("*") || allowedOrigins(env).includes(origin);
};

const responseJson = (request: Request, env: Env, status: number, body: Record<string, unknown>, cacheControl?: string): Response => {
  const headers = corsHeaders(request, env);
  headers.set("content-type", "application/json; charset=utf-8");
  if (cacheControl) headers.set("cache-control", cacheControl);
  return new Response(JSON.stringify(body), { status, headers });
};

const enforceRateLimit = async (request: Request, env: Env, key: string): Promise<boolean> => {
  if (!env.RATE_LIMITER) return true;
  try {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    return (await env.RATE_LIMITER.limit({ key: `${ip}:${key}` })).success;
  } catch {
    return true;
  }
};

const hashKey = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const storageKey = async (channel: ChannelRequest): Promise<string> => `live:v1:${await hashKey(channel.key)}`;

const parseStoredResult = (value: unknown, channel: ChannelRequest): LiveChannelResult | undefined => {
  if (!jsonObject(value)) return undefined;
  const validStatus = value.status === "live" || value.status === "offline" || value.status === "unavailable" || value.status === "unsupported";
  const validLive = typeof value.live === "boolean" || value.live === null;
  if (
    value.id !== channel.key
    || value.provider !== channel.provider
    || value.channel !== channel.channel
    || typeof value.url !== "string"
    || !validStatus
    || !validLive
    || typeof value.checkedAt !== "string"
  ) return undefined;
  return value as unknown as LiveChannelResult;
};

const readSnapshot = async (env: Env, key: string, channel: ChannelRequest): Promise<CachedSnapshot | undefined> => {
  if (!env.LIVE_CACHE) return undefined;
  try {
    const value = await env.LIVE_CACHE.get(key, "json");
    if (!jsonObject(value)) return undefined;
    const result = parseStoredResult(value.result, channel);
    return result ? { result } : undefined;
  } catch {
    return undefined;
  }
};

const writeSnapshot = async (env: Env, key: string, result: LiveChannelResult): Promise<void> => {
  if (!env.LIVE_CACHE) return;
  try {
    await env.LIVE_CACHE.put(key, JSON.stringify({ result }), { expirationTtl: SNAPSHOT_RETENTION_SECONDS });
  } catch {
    // Persistent fallback failure must not make the public endpoint fail.
  }
};

const readSnapshots = async (channels: ChannelRequest[], env: Env): Promise<Map<string, CachedSnapshot | undefined>> => {
  const entries = await Promise.all(
    channels.map(async (channel) => [channel.key, await readSnapshot(env, await storageKey(channel), channel)] as const),
  );
  return new Map(entries);
};

const edgeCacheRequest = async (request: Request, channel: ChannelRequest): Promise<Request> => {
  const url = new URL(request.url);
  url.pathname = `/__heimdall_cache/live/${await hashKey(channel.key)}`;
  url.search = "";
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
};

const readEdgeCached = async (request: Request, channel: ChannelRequest): Promise<LiveChannelResult | undefined> => {
  try {
    const response = await caches.default.match(await edgeCacheRequest(request, channel));
    return response ? parseStoredResult(await response.json(), channel) : undefined;
  } catch {
    return undefined;
  }
};

const writeEdgeCached = async (request: Request, channel: ChannelRequest, result: LiveChannelResult, env: Env): Promise<void> => {
  try {
    const response = new Response(JSON.stringify(result), {
      headers: {
        "cache-control": `public, s-maxage=${cacheTtl(env)}`,
        "content-type": "application/json; charset=utf-8",
      },
    });
    await caches.default.put(await edgeCacheRequest(request, channel), response);
  } catch {
    // Edge cache support depends on the deployment route and must remain optional.
  }
};

const readEdgeCachedChannels = async (request: Request, channels: ChannelRequest[]): Promise<Map<string, LiveChannelResult | undefined>> => {
  const entries = await Promise.all(channels.map(async (channel) => [channel.key, await readEdgeCached(request, channel)] as const));
  return new Map(entries);
};

const snapshotChanged = (current: LiveChannelResult, snapshot: CachedSnapshot | undefined): boolean => {
  if (current.status !== "live" && current.status !== "offline") return false;
  const old = snapshot?.result;
  return !old
    || old.status !== current.status
    || old.live !== current.live
    || old.url !== current.url
    || old.title !== current.title
    || old.category !== current.category
    || old.startedAt !== current.startedAt;
};

const mergeStaleResult = (current: LiveChannelResult, snapshot: CachedSnapshot | undefined): LiveChannelResult => {
  if (!snapshot) return current;
  const old = snapshot.result;
  if (current.status !== "unavailable" || (old.status !== "live" && old.status !== "offline")) return current;
  return {
    ...current,
    stale: true,
    lastKnown: { status: old.status, live: old.live === true, checkedAt: old.checkedAt },
  };
};

const refreshChannels = async (
  channels: ChannelRequest[],
  env: Env,
  snapshots: Map<string, CachedSnapshot | undefined>,
  request?: Request,
  context?: ExecutionContext,
): Promise<{ requestedAt: string; channels: LiveChannelResult[] }> => {
  const requestedAt = new Date().toISOString();
  const updates: Promise<void>[] = [];
  const results = await Promise.all(channels.map(async (channel) => {
    const snapshot = snapshots.get(channel.key);
    const current = await fetchProviderStatus(channel, env, requestedAt);
    if (snapshotChanged(current, snapshot)) updates.push(writeSnapshot(env, await storageKey(channel), current));
    const result = mergeStaleResult(current, snapshot);
    if (request) updates.push(writeEdgeCached(request, channel, result, env));
    return result;
  }));

  const updatePromise = Promise.all(updates).then(() => undefined);
  if (context) context.waitUntil(updatePromise);
  else await updatePromise;
  return { requestedAt, channels: results };
};

const defaultChannels = (env: Env): { channels?: ChannelRequest[]; error?: string } => {
  const values = env.DEFAULT_CHANNELS ? [env.DEFAULT_CHANNELS] : [];
  return parseSpecs(values, undefined, maxChannels(env));
};

const requestChannels = (url: URL, env: Env): { channels?: ChannelRequest[]; error?: string } => {
  const values = [...url.searchParams.getAll("channel"), ...url.searchParams.getAll("channels")];
  if (values.length === 0) return defaultChannels(env);
  return parseSpecs(values, url.searchParams.get("provider") ?? undefined, maxChannels(env));
};

const liveEndpoint = async (request: Request, env: Env, context: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  const parsed = requestChannels(url, env);
  if (!parsed.channels) {
    return responseJson(request, env, 400, {
      error: parsed.error ?? "invalid_channels",
      usage: "/v1/live?channels=twitch:buzs,tiktok:buzs",
    });
  }

  const edgeCached = await readEdgeCachedChannels(request, parsed.channels);
  const missing = parsed.channels.filter((channel) => !edgeCached.get(channel.key));
  if (missing.length === 0) {
    const channels = parsed.channels.map((channel) => edgeCached.get(channel.key)).filter((channel): channel is LiveChannelResult => Boolean(channel));
    const isStale = channels.some((channel) => channel.stale);
    return responseJson(request, env, 200, {
      service: SERVICE_NAME,
      requestedAt: new Date().toISOString(),
      channels,
      cache: isStale ? "stale" : "hit",
    }, "private, no-store");
  }

  const snapshots = await readSnapshots(missing, env);
  const refreshed = await refreshChannels(missing, env, snapshots, request, context);
  const refreshedByKey = new Map(missing.map((channel, index) => [channel.key, refreshed.channels[index]]));
  const channels = parsed.channels.map((channel) => edgeCached.get(channel.key) ?? refreshedByKey.get(channel.key)).filter((channel): channel is LiveChannelResult => Boolean(channel));
  const isStale = channels.some((channel) => channel.stale);
  return responseJson(request, env, 200, {
    service: SERVICE_NAME,
    requestedAt: refreshed.requestedAt,
    channels,
    cache: isStale ? "stale" : "miss",
  }, "private, no-store");
};

const refreshDefaults = async (env: Env): Promise<void> => {
  const parsed = defaultChannels(env);
  if (!parsed.channels) return;
  const snapshots = await readSnapshots(parsed.channels, env);
  await refreshChannels(parsed.channels, env, snapshots);
};

const handleRequest = async (request: Request, env: Env, context: ExecutionContext): Promise<Response> => {
  if (!isAllowedOrigin(request, env)) return responseJson(request, env, 403, { error: "origin_not_allowed" });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (request.method !== "GET" && request.method !== "HEAD") return responseJson(request, env, 405, { error: "method_not_allowed" });

  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return responseJson(request, env, 200, { service: SERVICE_NAME, status: "ok", time: new Date().toISOString() }, "no-store");
  }
  if (url.pathname === "/" || url.pathname === "/v1") {
    return responseJson(request, env, 200, {
      service: SERVICE_NAME,
      endpoints: { live: "/v1/live?channels=twitch:buzs,tiktok:buzs", health: "/health" },
      providers: ["twitch", "youtube", "tiktok", "kick"],
    }, "no-store");
  }
  if (url.pathname !== "/v1/live") return responseJson(request, env, 404, { error: "not_found" });
  if (!(await enforceRateLimit(request, env, "live"))) return responseJson(request, env, 429, { error: "rate_limited" });
  return liveEndpoint(request, env, context);
};

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, context);
  },
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(refreshDefaults(env));
  },
};

import { fetchProviderStatus } from "./providers";
import type { CachedEntry, ChannelRequest, Env, LiveChannelResult, LiveResponse, ProviderName } from "./types";

const SERVICE_NAME = "heimdall";
const DEFAULT_MAX_CHANNELS = 12;
const MAX_CHANNEL_SPEC_LENGTH = 160;
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

const cacheKey = async (channel: ChannelRequest): Promise<string> => `live:v1:${await hashKey(channel.key)}`;

const readCached = async (env: Env, key: string): Promise<CachedEntry | undefined> => {
  if (!env.LIVE_CACHE) return undefined;
  try {
    const value = await env.LIVE_CACHE.get(key, "json");
    if (!jsonObject(value) || !jsonObject(value.result) || typeof value.expiresAt !== "number") return undefined;
    const result = value.result;
    if (typeof result.id !== "string" || typeof result.provider !== "string" || typeof result.channel !== "string" || typeof result.status !== "string" || typeof result.checkedAt !== "string") {
      return undefined;
    }
    return { result: result as unknown as LiveChannelResult, expiresAt: value.expiresAt };
  } catch {
    return undefined;
  }
};

const writeCached = async (env: Env, key: string, result: LiveChannelResult): Promise<void> => {
  if (!env.LIVE_CACHE) return;
  try {
    const retention = Math.max(cacheTtl(env) * 10, 300);
    await env.LIVE_CACHE.put(key, JSON.stringify({ result, expiresAt: Date.now() + cacheTtl(env) * 1_000 }), { expirationTtl: retention });
  } catch {
    // A cache failure must not make the public status endpoint fail.
  }
};

const readCachedChannels = async (channels: ChannelRequest[], env: Env): Promise<Map<string, CachedEntry | undefined>> => {
  const entries = await Promise.all(
    channels.map(async (channel) => [channel.key, await readCached(env, await cacheKey(channel))] as const),
  );
  return new Map(entries);
};

const mergeStaleResult = (current: LiveChannelResult, cached: CachedEntry | undefined): LiveChannelResult => {
  if (!cached) return current;
  const old = cached.result;
  if (current.status !== "unavailable" || (old.status !== "live" && old.status !== "offline")) return current;
  return {
    ...current,
    stale: true,
    lastKnown: { status: old.status, live: old.live === true, checkedAt: old.checkedAt },
  };
};

const fetchLiveResponse = async (channels: ChannelRequest[], env: Env, cached: Map<string, CachedEntry | undefined>): Promise<Omit<LiveResponse, "cache">> => {
  const requestedAt = new Date().toISOString();
  const merged = await Promise.all(channels.map(async (channel) => {
    const previous = cached.get(channel.key);
    if (previous && previous.expiresAt > Date.now()) return previous.result;

    const current = await fetchProviderStatus(channel, env, requestedAt);
    if (current.status !== "unavailable") await writeCached(env, await cacheKey(channel), current);
    return mergeStaleResult(current, previous);
  }));
  const response: Omit<LiveResponse, "cache"> = { service: SERVICE_NAME, requestedAt, channels: merged };
  return response;
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

const liveEndpoint = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const parsed = requestChannels(url, env);
  if (!parsed.channels) {
    return responseJson(request, env, 400, {
      error: parsed.error ?? "invalid_channels",
      usage: "/v1/live?channels=twitch:buzs,tiktok:buzs",
    });
  }

  const cached = await readCachedChannels(parsed.channels, env);
  const allFresh = parsed.channels.every((channel) => {
    const entry = cached.get(channel.key);
    return entry && entry.expiresAt > Date.now();
  });
  if (allFresh) {
    return responseJson(request, env, 200, {
      service: SERVICE_NAME,
      requestedAt: new Date().toISOString(),
      channels: parsed.channels.map((channel) => cached.get(channel.key)?.result).filter((channel): channel is LiveChannelResult => Boolean(channel)),
      cache: "hit",
    }, "private, no-store");
  }

  const response = await fetchLiveResponse(parsed.channels, env, cached);
  const isStale = response.channels.some((channel) => channel.stale);
  return responseJson(request, env, 200, { ...response, cache: isStale ? "stale" : "miss" }, "private, no-store");
};

const refreshDefaults = async (env: Env): Promise<void> => {
  const parsed = defaultChannels(env);
  if (!parsed.channels) return;
  const cached = await readCachedChannels(parsed.channels, env);
  await fetchLiveResponse(parsed.channels, env, cached);
};

const handleRequest = async (request: Request, env: Env): Promise<Response> => {
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
  return liveEndpoint(request, env);
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(refreshDefaults(env));
  },
};

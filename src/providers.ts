import type { ChannelRequest, Env, LiveChannelResult, ProviderName } from "./types";

type JsonObject = Record<string, unknown>;

let twitchToken: { value: string; expiresAt: number } | undefined;
let twitchTokenRequest: Promise<string | undefined> | undefined;
let kickToken: { value: string; expiresAt: number } | undefined;
let kickTokenRequest: Promise<string | undefined> | undefined;

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

const readString = (object: JsonObject, key: string, max = 500): string | undefined => {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
};

const readNumber = (object: JsonObject, key: string): number | undefined => {
  const value = object[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const readBoolean = (object: JsonObject, key: string): boolean | undefined => {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
};

const channelUrl = (provider: ProviderName, channel: string): string => {
  if (provider === "twitch") return `https://www.twitch.tv/${encodeURIComponent(channel)}`;
  if (provider === "youtube") return `https://www.youtube.com/channel/${encodeURIComponent(channel)}`;
  if (provider === "tiktok") return `https://www.tiktok.com/@${encodeURIComponent(channel)}`;
  return `https://kick.com/${encodeURIComponent(channel)}`;
};

const unavailable = (
  request: ChannelRequest,
  checkedAt: string,
  error: "provider_not_configured" | "provider_error",
): LiveChannelResult => ({
  id: request.key,
  provider: request.provider,
  channel: request.channel,
  url: channelUrl(request.provider, request.channel),
  status: "unavailable",
  live: null,
  checkedAt,
  error,
});

const offline = (request: ChannelRequest, checkedAt: string): LiveChannelResult => ({
  id: request.key,
  provider: request.provider,
  channel: request.channel,
  url: channelUrl(request.provider, request.channel),
  status: "offline",
  live: false,
  checkedAt,
});

const unsupported = (request: ChannelRequest, checkedAt: string): LiveChannelResult => ({
  id: request.key,
  provider: request.provider,
  channel: request.channel,
  url: channelUrl(request.provider, request.channel),
  status: "unsupported",
  live: null,
  checkedAt,
  error: "provider_not_supported",
});

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const twitchAccessToken = async (env: Env): Promise<string | undefined> => {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return undefined;
  if (twitchToken && twitchToken.expiresAt > Date.now() + 60_000) return twitchToken.value;
  if (twitchTokenRequest) return twitchTokenRequest;

  twitchTokenRequest = (async () => {
    try {
      const body = new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID ?? "",
        client_secret: env.TWITCH_CLIENT_SECRET ?? "",
        grant_type: "client_credentials",
      });
      const response = await fetchWithTimeout("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) return undefined;
      const responseBody = (await response.json()) as unknown;
      if (!isObject(responseBody)) return undefined;
      const accessToken = readString(responseBody, "access_token", 1000);
      const expiresIn = readNumber(responseBody, "expires_in") ?? 3_600;
      if (!accessToken) return undefined;
      twitchToken = { value: accessToken, expiresAt: Date.now() + expiresIn * 1_000 };
      return accessToken;
    } catch {
      return undefined;
    }
  })().finally(() => {
    twitchTokenRequest = undefined;
  });

  return twitchTokenRequest;
};

const fetchTwitch = async (request: ChannelRequest, env: Env, checkedAt: string): Promise<LiveChannelResult> => {
  const accessToken = await twitchAccessToken(env);
  if (!accessToken) {
    return unavailable(request, checkedAt, env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET ? "provider_error" : "provider_not_configured");
  }

  try {
    const url = new URL("https://api.twitch.tv/helix/streams");
    url.searchParams.set("user_login", request.channel);
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/json",
        "Client-Id": env.TWITCH_CLIENT_ID ?? "",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) return unavailable(request, checkedAt, "provider_error");

    const body = (await response.json()) as unknown;
    const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
    const stream = isObject(data[0]) ? data[0] : undefined;
    if (!stream) return offline(request, checkedAt);

    return {
      id: request.key,
      provider: request.provider,
      channel: request.channel,
      url: channelUrl(request.provider, request.channel),
      status: "live",
      live: true,
      title: readString(stream, "title"),
      category: readString(stream, "game_name"),
      viewers: readNumber(stream, "viewer_count"),
      startedAt: readString(stream, "started_at", 80),
      checkedAt,
    };
  } catch {
    return unavailable(request, checkedAt, "provider_error");
  }
};

const fetchYouTube = async (request: ChannelRequest, env: Env, checkedAt: string): Promise<LiveChannelResult> => {
  if (!env.YOUTUBE_API_KEY) return unavailable(request, checkedAt, "provider_not_configured");

  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("channelId", request.channel);
    searchUrl.searchParams.set("eventType", "live");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("maxResults", "1");
    searchUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
    const searchResponse = await fetchWithTimeout(searchUrl);
    if (!searchResponse.ok) return unavailable(request, checkedAt, "provider_error");

    const searchBody = (await searchResponse.json()) as unknown;
    const items = isObject(searchBody) && Array.isArray(searchBody.items) ? searchBody.items : [];
    const item = isObject(items[0]) ? items[0] : undefined;
    const id = item && isObject(item.id) ? readString(item.id, "videoId", 100) : undefined;
    const snippet = item && isObject(item.snippet) ? item.snippet : undefined;
    if (!id) return offline(request, checkedAt);

    let viewers: number | undefined;
    try {
      const videoUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      videoUrl.searchParams.set("part", "liveStreamingDetails");
      videoUrl.searchParams.set("id", id);
      videoUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
      const videoResponse = await fetchWithTimeout(videoUrl);
      if (videoResponse.ok) {
        const videoBody = (await videoResponse.json()) as unknown;
        const videoItems = isObject(videoBody) && Array.isArray(videoBody.items) ? videoBody.items : [];
        const video = isObject(videoItems[0]) && isObject(videoItems[0].liveStreamingDetails) ? videoItems[0].liveStreamingDetails : undefined;
        if (video) viewers = readNumber(video, "concurrentViewers");
      }
    } catch {
      // A live search result remains valid when optional viewer details fail.
    }

    return {
      id: request.key,
      provider: request.provider,
      channel: request.channel,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      status: "live",
      live: true,
      title: snippet ? readString(snippet, "title") : undefined,
      viewers,
      checkedAt,
    };
  } catch {
    return unavailable(request, checkedAt, "provider_error");
  }
};

const fetchTikTok = async (request: ChannelRequest, env: Env, checkedAt: string): Promise<LiveChannelResult> => {
  if (!env.TIKTOK_STATUS_SERVICE_URL) return unavailable(request, checkedAt, "provider_not_configured");

  try {
    const url = new URL(env.TIKTOK_STATUS_SERVICE_URL);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return unavailable(request, checkedAt, "provider_error");
    }
    url.searchParams.set("channel", request.channel);
    const headers = new Headers({ Accept: "application/json" });
    if (env.TIKTOK_STATUS_SERVICE_TOKEN) headers.set("Authorization", `Bearer ${env.TIKTOK_STATUS_SERVICE_TOKEN}`);
    const response = await fetchWithTimeout(url, { headers });
    if (!response.ok) return unavailable(request, checkedAt, "provider_error");

    const body = (await response.json()) as unknown;
    if (!isObject(body)) return unavailable(request, checkedAt, "provider_error");
    const status = readString(body, "status", 30);
    if (status === "offline") return offline(request, checkedAt);
    if (status !== "live" || readBoolean(body, "live") !== true) return unavailable(request, checkedAt, "provider_error");

    return {
      id: request.key,
      provider: request.provider,
      channel: request.channel,
      url: channelUrl(request.provider, request.channel),
      status: "live",
      live: true,
      title: readString(body, "title"),
      category: readString(body, "category"),
      viewers: readNumber(body, "viewers"),
      startedAt: readString(body, "startedAt", 80),
      checkedAt,
    };
  } catch {
    return unavailable(request, checkedAt, "provider_error");
  }
};

const kickAccessToken = async (env: Env): Promise<string | undefined> => {
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) return undefined;
  if (kickToken && kickToken.expiresAt > Date.now() + 60_000) return kickToken.value;
  if (kickTokenRequest) return kickTokenRequest;

  kickTokenRequest = (async () => {
    try {
      const body = new URLSearchParams({
        client_id: env.KICK_CLIENT_ID ?? "",
        client_secret: env.KICK_CLIENT_SECRET ?? "",
        grant_type: "client_credentials",
      });
      const response = await fetchWithTimeout("https://id.kick.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) return undefined;
      const responseBody = (await response.json()) as unknown;
      if (!isObject(responseBody)) return undefined;
      const accessToken = readString(responseBody, "access_token", 1000);
      const expiresIn = readNumber(responseBody, "expires_in") ?? 3_600;
      if (!accessToken) return undefined;
      kickToken = { value: accessToken, expiresAt: Date.now() + expiresIn * 1_000 };
      return accessToken;
    } catch {
      return undefined;
    }
  })().finally(() => {
    kickTokenRequest = undefined;
  });

  return kickTokenRequest;
};

const fetchKick = async (request: ChannelRequest, env: Env, checkedAt: string): Promise<LiveChannelResult> => {
  const accessToken = await kickAccessToken(env);
  if (!accessToken) {
    return unavailable(request, checkedAt, env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET ? "provider_error" : "provider_not_configured");
  }

  try {
    const url = new URL("https://api.kick.com/public/v1/channels");
    url.searchParams.set("slug", request.channel);
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) return unavailable(request, checkedAt, "provider_error");

    const body = (await response.json()) as unknown;
    const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
    const channel = isObject(data[0]) ? data[0] : undefined;
    const stream = channel && isObject(channel.stream) ? channel.stream : undefined;
    if (!stream || readBoolean(stream, "is_live") !== true) return offline(request, checkedAt);

    const category = channel && isObject(channel.category) ? channel.category : undefined;
    return {
      id: request.key,
      provider: request.provider,
      channel: request.channel,
      url: channelUrl(request.provider, request.channel),
      status: "live",
      live: true,
      title: channel ? readString(channel, "stream_title") : undefined,
      category: category ? readString(category, "name") : undefined,
      viewers: readNumber(stream, "viewer_count"),
      startedAt: readString(stream, "start_time", 80),
      checkedAt,
    };
  } catch {
    return unavailable(request, checkedAt, "provider_error");
  }
};

export const fetchProviderStatus = async (request: ChannelRequest, env: Env, checkedAt: string): Promise<LiveChannelResult> => {
  if (request.provider === "twitch") return fetchTwitch(request, env, checkedAt);
  if (request.provider === "youtube") return fetchYouTube(request, env, checkedAt);
  if (request.provider === "tiktok") return fetchTikTok(request, env, checkedAt);
  if (request.provider === "kick") return fetchKick(request, env, checkedAt);
  return unsupported(request, checkedAt);
};

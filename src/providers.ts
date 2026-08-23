import type { ChannelRequest, Env, LiveChannelResult, ProviderName } from "./types";

type JsonObject = Record<string, unknown>;

let twitchToken: { value: string; expiresAt: number } | undefined;

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

const readString = (object: JsonObject, key: string, max = 500): string | undefined => {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
};

const readNumber = (object: JsonObject, key: string): number | undefined => {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
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

  const tokenUrl = new URL("https://id.twitch.tv/oauth2/token");
  tokenUrl.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
  tokenUrl.searchParams.set("client_secret", env.TWITCH_CLIENT_SECRET);
  tokenUrl.searchParams.set("grant_type", "client_credentials");

  try {
    const response = await fetchWithTimeout(tokenUrl, { method: "POST" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (!isObject(body)) return undefined;
    const accessToken = readString(body, "access_token", 1000);
    const expiresIn = readNumber(body, "expires_in") ?? 3_600;
    if (!accessToken) return undefined;
    twitchToken = { value: accessToken, expiresAt: Date.now() + expiresIn * 1_000 };
    return accessToken;
  } catch {
    return undefined;
  }
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
    if (!stream) {
      return { ...unavailable(request, checkedAt, "provider_error"), status: "offline", live: false, error: undefined };
    }

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
    if (!id) {
      return { ...unavailable(request, checkedAt, "provider_error"), status: "offline", live: false, error: undefined };
    }

    let viewers: number | undefined;
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

export const fetchProviderStatus = async (request: ChannelRequest, env: Env, checkedAt: string): Promise<LiveChannelResult> => {
  if (request.provider === "twitch") return fetchTwitch(request, env, checkedAt);
  if (request.provider === "youtube") return fetchYouTube(request, env, checkedAt);
  return unsupported(request, checkedAt);
};

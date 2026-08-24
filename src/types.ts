export type ProviderName = "twitch" | "youtube" | "tiktok" | "kick";

export type ChannelRequest = {
  provider: ProviderName;
  channel: string;
  key: string;
};

export type ChannelStatus = "live" | "offline" | "unavailable" | "unsupported";

export type LiveChannelResult = {
  id: string;
  provider: ProviderName;
  channel: string;
  url: string;
  status: ChannelStatus;
  live: boolean | null;
  title?: string;
  category?: string;
  viewers?: number;
  startedAt?: string;
  checkedAt: string;
  stale?: boolean;
  lastKnown?: {
    status: "live" | "offline";
    live: boolean;
    checkedAt: string;
  };
  error?: "provider_not_configured" | "provider_error" | "provider_not_supported";
};

export type LiveResponse = {
  service: "heimdall";
  requestedAt: string;
  cache: "hit" | "miss" | "stale";
  channels: LiveChannelResult[];
};

export type CachedSnapshot = {
  result: LiveChannelResult;
};

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  LIVE_CACHE?: KVNamespace;
  RATE_LIMITER?: RateLimiter;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  YOUTUBE_API_KEY?: string;
  KICK_CLIENT_ID?: string;
  KICK_CLIENT_SECRET?: string;
  TIKTOK_STATUS_SERVICE_URL?: string;
  TIKTOK_STATUS_SERVICE_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
  CACHE_TTL_SECONDS?: string;
  DEFAULT_CHANNELS?: string;
  MAX_CHANNELS?: string;
}

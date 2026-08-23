# Buzs Live Status

Microservico Cloudflare Worker para consultar o estado de canais de live por query string. O site de links permanece estatico; este Worker concentra credenciais, chamadas aos provedores e cache.

## API

Endpoint principal:

```text
GET /v1/live?channels=twitch:buzs,tiktok:buzs
```

Tambem sao aceitas estas formas:

```text
GET /v1/live?channel=twitch:buzs&channel=youtube:UC00000000000000000000
GET /v1/live?provider=twitch&channels=buzs,outro-canal
```

Quando nenhum canal e enviado, o Worker usa `DEFAULT_CHANNELS` do `wrangler.toml`. O limite padrao e de 12 canais por consulta; o provedor e sempre validado contra uma allowlist para impedir SSRF ou chamadas arbitrarias.

Resposta de exemplo:

```json
{
  "service": "buzs-live-status",
  "requestedAt": "2026-08-23T18:30:00.000Z",
  "cache": "miss",
  "channels": [
    {
      "id": "twitch:buzs",
      "provider": "twitch",
      "channel": "buzs",
      "url": "https://www.twitch.tv/buzs",
      "status": "live",
      "live": true,
      "title": "Minecraft",
      "category": "Minecraft",
      "viewers": 42,
      "startedAt": "2026-08-23T18:00:00Z",
      "checkedAt": "2026-08-23T18:30:00.000Z"
    }
  ]
}
```

Estados de canal:

- `live`: o provedor confirmou uma transmissao.
- `offline`: a consulta foi valida e nao ha transmissao.
- `unavailable`: credencial ausente, timeout ou erro temporario do provedor.
- `unsupported`: o adaptador ainda nao existe para aquele provedor.

Quando existe um resultado anterior em KV e a consulta atual falha, o canal recebe `stale: true` e `lastKnown`. O servico nao transforma uma falha temporaria em `offline`.

## Provedores

- Twitch: implementado com Helix `Get Streams` e Client Credentials.
- YouTube: implementado com YouTube Data API usando o ID do canal, normalmente iniciado por `UC`.
- TikTok: integrado por um servico Node externo, usando `tiktok-live-connector`. A biblioteca nao e uma API oficial do TikTok.
- Kick: implementado com a API publica v1 e OAuth client credentials.

Novos provedores devem ser adicionados em `src/providers.ts`, sem aceitar URLs de API pela query string.

## Configuracao

Instale as dependencias usando `mise`:

```bash
mise exec -- npm install
```

Crie uma namespace KV e substitua os IDs em `wrangler.toml`:

```bash
mise exec -- npm exec -- wrangler kv namespace create LIVE_CACHE
mise exec -- npm exec -- wrangler kv namespace create LIVE_CACHE --preview
```

Para desenvolvimento local, copie `.dev.vars.example` para `.dev.vars` e preencha somente credenciais de teste:

```bash
copy .dev.vars.example .dev.vars
mise exec -- npm run dev
```

Secrets de producao:

```bash
mise exec -- npm exec -- wrangler secret put TWITCH_CLIENT_ID
mise exec -- npm exec -- wrangler secret put TWITCH_CLIENT_SECRET
mise exec -- npm exec -- wrangler secret put YOUTUBE_API_KEY
mise exec -- npm exec -- wrangler secret put KICK_CLIENT_ID
mise exec -- npm exec -- wrangler secret put KICK_CLIENT_SECRET
mise exec -- npm exec -- wrangler secret put TIKTOK_STATUS_SERVICE_TOKEN
```

Defina `TIKTOK_STATUS_SERVICE_URL` em `[vars]` no `wrangler.toml` com a URL HTTPS publica do endpoint `/v1/status` do servico Node. O `TIKTOK_STATUS_SERVICE_TOKEN` deve ser igual nos dois servicos.

O `ALLOWED_ORIGINS` deve conter a origem da pagina, separada por virgulas quando houver mais de uma. `CACHE_TTL_SECONDS` controla a validade do snapshot em KV e `DEFAULT_CHANNELS` define os canais atualizados pelo Cron Trigger.

## Servico TikTok

O servico Node deve existir e ser hospedado fora deste repositorio. O contrato que ele precisa implementar esta definido em `F:/Projects/buz/tiktok-status-service/AGENTS.md`.

Ele deve expor `GET /v1/status?channel=<username>` sobre HTTPS, exigir um token compartilhado com o Worker e retornar `live`, `offline` ou `unavailable`. Antes de expor o servico, configure rate limit e HTTPS; o navegador nunca recebe esse token.

## Desenvolvimento e deploy

```bash
mise exec -- npm run typecheck
mise exec -- npm run dev
mise exec -- npm run deploy
```

O Cron Trigger atualiza `DEFAULT_CHANNELS` uma vez por minuto. Consultas com outros canais continuam funcionando sob demanda e usam a mesma cache por combinacao normalizada de provedor e canal.

O endpoint `/health` nao consulta provedores. O endpoint `/` documenta as rotas e os provedores sem expor secrets.

## Seguranca e operacao

- Nunca enviar Client IDs, Client Secrets ou API keys ao frontend.
- Nunca aceitar URL de provedor vinda da query string.
- Manter CORS restrito em `ALLOWED_ORIGINS` em producao.
- Adicionar um binding `RATE_LIMITER` se o endpoint ficar publico em grande escala.
- Monitorar quotas da Twitch e do YouTube antes de reduzir o TTL.
- O conector TikTok e nao oficial e depende de protocolo interno; monitorar quebras, termos de uso e manutencao.

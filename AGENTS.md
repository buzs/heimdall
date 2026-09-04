# Instrucoes para agentes

Este projeto e um microservico Cloudflare Worker independente do site publico de links. Leia este arquivo antes de alterar o Worker.

## Objetivo

Consultar status de canais de live por query string, mantendo credenciais e chamadas aos provedores no servidor. O servico deve ser reutilizavel por qualquer pagina, nao apenas pelo perfil Buzs.

## Execucao

Node esta fixado em `mise.toml`. Use sempre `mise`:

```powershell
mise trust
mise install
mise run install
mise run check
mise run dev
```

`mise run check` executa typecheck e valida o bundle do Worker. Deploy continua
explicito com `mise exec -- npm run deploy`.

O build/verificacao principal e `mise exec -- npm run typecheck`. `wrangler deploy --dry-run` pode ser usado para validar o bundle:

```powershell
mise exec -- npm exec -- wrangler deploy --dry-run
```

Nao usar `node`, `npm` ou `npx` diretamente quando o comando puder ser executado com `mise`. Nao criar commit ou fazer push sem solicitacao.

## Estrutura

- `src/index.ts`: roteamento, CORS, query parsing, cache, rate limit e Cron Trigger.
- `src/providers.ts`: adaptadores fixos de provedores.
- `src/types.ts`: contrato de ambiente e resposta.
- `wrangler.toml`: configuracao nao secreta, KV e Cron.
- `.dev.vars.example`: nomes das credenciais locais; nunca preencher e commitar este arquivo.
- `README.md`: contrato publico, setup e deploy.

## API publica

Use `GET /v1/live?channels=twitch:buzs,tiktok:buzs` para consultar varios canais. Tambem sao aceitos `channel` repetido e `provider` junto com nomes sem prefixo:

```text
/v1/live?channel=twitch:buzs&channel=youtube:UC00000000000000000000
/v1/live?provider=twitch&channels=buzs,outro-canal
```

Quando a query nao informa canais, `DEFAULT_CHANNELS` e usado. O limite padrao e 12. Cada especificacao e normalizada, deduplicada e validada por provedor. Nunca aceitar URL arbitraria, hostname ou caminho de API pela query.

O contrato de canal usa `status` (`live`, `offline`, `unavailable`, `unsupported`) e `live` (`true`, `false` ou `null`). Falha temporaria nunca vira offline. Quando houver snapshot anterior em KV, usar `stale: true` e `lastKnown`.

## Provedores

- Twitch usa Helix `Get Streams` com Client Credentials.
- YouTube usa YouTube Data API com ID de canal `UC...`.
- Kick usa a API publica v1 com OAuth client credentials.
- TikTok e resolvido pelo Huginn, chamando `GET /v1/status` em
  `TIKTOK_STATUS_SERVICE_URL` com o token compartilhado. O Heimdall nunca fala
  com o TikTok diretamente e nunca importa um conector nao oficial.
- `unsupported` fica reservado para um provedor sem adaptador.
- Hosts de API ficam fixos em `src/providers.ts`.

Um novo adaptador deve manter o mesmo contrato, timeout de 8 segundos, sanitizacao de resposta e erro sem detalhes de credenciais. Nao fazer scraping de TikTok sem decisao explicita sobre termos de uso e manutencao.

## Cache e operacao

- `LIVE_CACHE` guarda por sete dias o ultimo snapshot por combinacao normalizada de provedor e canal.
- `CACHE_TTL_SECONDS` controla a validade do resultado recente na Cache API, com limite de seguranca no codigo.
- Cron Trigger verifica `DEFAULT_CHANNELS` a cada minuto. O KV so e regravado quando o resultado muda semanticamente; `checkedAt` e `viewers` nao contam como mudanca.
- Consultas arbitrarias continuam funcionando sob demanda.
- `RATE_LIMITER` e opcional, mas recomendado para endpoint publico.
- CORS deve ficar restrito em `ALLOWED_ORIGINS` em producao.

Secrets permitidos: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `YOUTUBE_API_KEY`,
`KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` e `TIKTOK_STATUS_SERVICE_TOKEN`.
Configure-os somente com `wrangler secret put`; nunca os coloque em
`wrangler.toml`, `src/`, README ou frontend. O `TIKTOK_STATUS_SERVICE_TOKEN`
precisa ser identico ao token configurado no Huginn e nunca chega ao navegador.

Antes de publicar, crie a namespace KV e substitua os IDs placeholder de `wrangler.toml`. O projeto nao deve depender do `wrangler.toml` do Pages.

## Processo

1. Ler este arquivo e o README.
2. Verificar o estado do diretorio e nao reverter alteracoes de outros usuarios.
3. Manter providers sem SSRF e sem segredos no cliente.
4. Usar `apply_patch` para edicoes manuais.
5. Rodar `mise run check`, que cobre typecheck e o dry-run do bundle.
6. Informar no resumo os comandos executados e qualquer API/provedor ainda pendente.

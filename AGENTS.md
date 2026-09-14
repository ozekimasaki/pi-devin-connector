# AGENTS.md — pi-devin-connector

## Overview

A [pi](https://pi.dev) coding agent extension that registers the `devin` provider (Cognition / Windsurf) with OAuth login and native streaming. Forked from `pi-devin-auth` 0.1.2 and updated to the pi ≥0.85 extension spec. Reuses the cloud-direct gRPC layer from `opencode-windsurf-auth`.

## Architecture

```
extensions/index.ts          # pi extension entry — registerProvider("devin", { oauth, streamSimple, refreshModels, models })
src/oauth/
  login.ts                   # ADAPTED — pi OAuthLoginCallbacks (manual-paste flow, onManualCodeInput, signal)
  register-user.ts           # RegisterUser RPC at register.windsurf.com
  types.ts                   # WindsurfRegion, DEFAULT_REGION, token shape docs
src/cloud-direct/            # gRPC to server.codeium.com
  auth.ts                    #   GetUserJwt (short-lived JWT mint + in-memory cache)
  chat.ts                    #   GetChatMessage streaming (Connect-RPC + manual protobuf)
  catalog.ts                 #   GetCascadeModelConfigs (per-account model catalog)
  metadata.ts                #   Metadata proto builder
  wire.ts                    #   Protobuf + Connect-streaming envelope helpers
  index.ts                   #   Public re-exports
src/context-map.ts           # pi Message[]/Tool[] -> ChatHistoryItem[]/ToolDef[]
src/hosts.ts                 # api_key -> tenant api_server_url lookup (login + refreshModels populate)
src/stream.ts                # streamDevin: streamSimple impl (CloudChatEvent -> pi events)
src/models.ts                # dynamic catalog -> ProviderModelConfig[] (blocklist policy) + fallback + stored-model conversion
```

## Build & Test

```bash
npm install          # install deps
npm run typecheck    # tsc --noEmit
npm test             # node --test --import tsx tests/stream.test.ts
```

pi loads extensions via jiti (no build step needed for runtime use). Requires Node ≥22.19 (pi's own floor).

## Key Design Decisions

1. **Native streamSimple**: No background proxy. `streamDevin()` calls `streamChatEvents()` directly and emits pi's `AssistantMessageEventStream` events. Honors the pi ≥0.85 contract: `options.onPayload` (request-body inspect/replace), `options.onResponse` (post-headers hook), `options.fetch`, `options.headers`, `options.timeoutMs` (mapped to the TTFB timeout), `options.temperature`, `options.maxTokens`.
2. **`refreshModels` hook (pi ≥0.85)**: the provider declares a dynamic catalog. pi calls it at startup (network permitting), right after `/login devin` (pi refreshes the provider after credentials are stored), and after credential changes with `allowNetwork: false`. Fresh catalogs are persisted via `context.publish({ persist })` and restored from `context.stored` when offline. The old version re-registered the whole provider on `session_start` — no longer needed.
3. **Manual-paste OAuth**: pi's `OAuthLoginCallbacks` doesn't support loopback servers. We use `redirect_uri=show-auth-token` so the Windsurf SPA renders the token for the user to paste via `callbacks.onManualCodeInput()` (falls back to `onPrompt()`). `callbacks.signal` aborts the RegisterUser exchange.
4. **Non-expiring token shape**: Windsurf's `RegisterUser` returns a long-lived `api_key` with no refresh token. We set `OAuthCredentials = { refresh: "", access: apiKey, expires: now + 365 days, apiServerUrl, accountName }`. `refreshToken(credentials, signal)` is a no-op. Extra fields ride on the `OAuthCredentials` index signature.
5. **Tenant URL routing**: `RegisterUser`'s `api_server_url` is stashed on the credential and in a process-local `apiKey → host` map (`src/hosts.ts`) so `streamDevin` — which only receives the resolved key — still hits the right tenant.
6. **In-memory JWT cache only**: No disk persistence for the short-lived `user_jwt`. Re-mint cost (~200ms) is negligible.
7. **Catalog is authoritative, blocklist only**: The upstream package whitelisted 11 model families (`WANTED_PREFIXES`), which silently dropped every new family Cognition shipped (swe-2, opus-5, gpt-6-astra, ...). Since `GetCascadeModelConfigs` already scopes results to the account (`disabled` flag = entitlement), `buildLiveModels` now includes every enabled entry except `EXCLUDED_PREFIXES` (`swe-check`, `swe-grep`, `swe-1-mini`, `fast-context` — non-chat utilities). Pricing/context comes from `MODEL_META` (longest-prefix match, synced to docs.devin.ai/windsurf/plugins/cascade/models): `-priority`/`-fast` UIDs bill at 2x family rates, `-none` UIDs are `reasoning: false`, unknown UIDs fall back to `DEFAULT_META`.

## Token Shapes

- **firebaseIdToken**: Short-lived JWT from Auth0 browser sign-in. Exchanged via RegisterUser, then discarded.
- **api_key**: Long-lived credential from RegisterUser. Format: `devin-session-token$<JWT>`. Used as `Metadata.api_key` in every gRPC call. Stored by pi in `~/.pi/agent/auth.json`.
- **user_jwt**: Short-lived (~24 min) JWT minted from `GetUserJwt`. Cached in-memory per (apiKey, host). Required alongside api_key for chat RPCs.

## Cloud-Direct gRPC

All RPCs hit `https://server.codeium.com` over HTTPS with Connect-RPC framing:
- `GetUserJwt` — unary, `application/proto`
- `GetCascadeModelConfigs` — unary, `application/proto`
- `GetChatMessage` — streaming, `application/connect+proto` (gzip-compressed frames)

Manual protobuf encoding (no protobuf library). Field numbers hardcoded from mitm captures of Windsurf's language_server traffic.

## Related

- [pi-devin-auth](https://www.npmjs.com/package/pi-devin-auth) — the npm package this is forked from (upstream GitHub repo no longer exists)
- [opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth) — the opencode plugin the cloud-direct layer derives from
- [pi custom-provider docs](https://pi.dev/docs/latest/custom-provider)

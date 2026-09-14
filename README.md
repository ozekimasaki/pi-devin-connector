# pi-devin-connector

[![npm version](https://img.shields.io/npm/v/pi-devin-connector)](https://www.npmjs.com/package/pi-devin-connector)
[![npm downloads](https://img.shields.io/npm/dm/pi-devin-connector)](https://www.npmjs.com/package/pi-devin-connector)
[![license](https://img.shields.io/npm/l/pi-devin-connector)](https://github.com/ozekimasaki/pi-devin-connector/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/pi-devin-connector)](https://nodejs.org)
[![pi package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)

A [pi](https://pi.dev) coding agent extension that adds the **Devin** (Cognition / Windsurf) provider with browser-based OAuth login and native streaming.

> Fork of [`pi-devin-auth`](https://www.npmjs.com/package/pi-devin-auth) (nmzpy), updated for the pi ≥0.85 extension spec: the `refreshModels` dynamic-catalog hook, the `onPayload`/`onResponse`/`fetch`/`headers`/`timeoutMs` stream options, and the current OAuth callback surface.

## Features

- **OAuth login** — `/login devin` opens Windsurf sign-in; the token is exchanged for a long-lived Devin API key
- **Always-fresh model catalog** — every model enabled on your account is surfaced automatically (SWE-2, Claude Opus 5, GPT-6 Astra, Gemini 3.x, GLM-5.3, Kimi K3, DeepSeek V4, Grok 4.6, ...), with auto-refresh on session start, after each agent run, and on a 15-minute timer
- **Native streaming** — `streamSimple` implementation over Cognition's Connect-RPC (`GetChatMessage`): text, thinking, tool calls, usage & cost accounting
- **Tier-aware errors** — pre-flight catalog check turns Cognition's opaque `permission_denied` into a readable "not enabled on your plan" message
- **Multi-tenant** — honors the `api_server_url` returned at login (EU / FedStart tenants route correctly)

## Install

### Via pi (recommended)

```bash
pi install npm:pi-devin-connector
```

### Manual / local dev

```bash
pi -e ./extensions/index.ts
```

Or copy `extensions/index.ts` into `~/.pi/agent/extensions/` for auto-discovery.

## Usage

### Login

```
/login devin
```

This opens `https://windsurf.com/windsurf/signin` in your browser. After signing in, the page displays an auth token — paste it into the pi prompt. The extension exchanges it for a long-lived Devin API key via `register.windsurf.com`.

Right after login, pi refreshes the provider's model catalog automatically, so the live model list for your account tier appears immediately.

### Select a model

```
/model devin/swe-2-high
```

### Refresh the catalog manually

```
/devin-refresh
```

### Check auth state

```
/devin-status
```

### Logout

```
/logout devin
```

## How it works

```
pi  --login-->  windsurf.com (Auth0)  --token-->  register.windsurf.com (RegisterUser)  --api_key-->  ~/.pi/agent/auth.json
pi  --chat-->   streamDevin()  -->  cloud-direct/streamChatEvents()  -->  server.codeium.com (GetChatMessage gRPC)  -->  pi events
```

The extension reuses the battle-tested cloud-direct gRPC layer from [opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth) and wraps it in pi's native `streamSimple` + `oauth` extension API.

## Models

Models are fetched dynamically from Cognition's `GetCascadeModelConfigs` RPC via the `refreshModels` provider hook — at startup, after login, and on `/devin-refresh`. On top of that the extension keeps the list fresh **automatically**: it re-checks the catalog on every `session_start` (new / resume / fork), after each agent run (`agent_settled`), and on a 15-minute timer while a session is open. Checks that find a still-fresh cache (<10 min TTL) skip the network entirely, so a newly released Cognition model shows up in the picker on its own.

The catalog is persisted to pi's models store, so an offline start still shows the last-known list. A static fallback set is included for when nothing has been persisted yet.

The live catalog is **authoritative**: every enabled entry is surfaced as a chat model, including new families the extension has never seen (the server marks models your tier can't run as `disabled`, so no client-side allow-list is needed). Only a small blocklist of known non-chat utilities (`swe-check`, `swe-grep`, `swe-1-mini`, `fast-context`) is filtered out — see `EXCLUDED_PREFIXES` in `src/models.ts`.

Per-model context windows and pricing come from the `MODEL_META` prefix overlay, synced to the official table at <https://docs.devin.ai/windsurf/plugins/cascade/models>. `-priority` / `-fast` variants are billed at 2x family rates; `-none` variants are flagged non-reasoning. Unrecognized UIDs get conservative defaults so they're still usable.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test --import tsx tests/stream.test.ts
```

Requires Node ≥22.19 (pi's own floor). pi loads the extension via jiti — no build step needed.

## License

MIT — original work © 2026 nmzpy, modifications © 2026 Masaki Ozeki.

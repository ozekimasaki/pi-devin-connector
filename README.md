# pi-devin-connector

A [pi](https://pi.dev) coding agent extension that adds the **Devin** (Cognition / Windsurf) provider with browser-based OAuth login and native streaming.

> Fork of [`pi-devin-auth`](https://www.npmjs.com/package/pi-devin-auth) (nmzpy), updated for the pi ≥0.85 extension spec: the `refreshModels` dynamic-catalog hook, the `onPayload`/`onResponse`/`fetch`/`headers`/`timeoutMs` stream options, and the current OAuth callback surface.

## Install

### Via pi (recommended)

```bash
pi install npm:pi-devin-connector
```

Then enable the extension:

```bash
pi config
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
/model devin/swe-1-7
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

Models are fetched dynamically from Cognition's `GetCascadeModelConfigs` RPC via the `refreshModels` provider hook — at startup, after login, and on `/devin-refresh`. The catalog is persisted to pi's models store, so an offline start still shows the last-known list. A static fallback set is included for when nothing has been persisted yet.

## License

MIT — original work © 2026 nmzpy, modifications © 2026 Masaki Ozeki.

/**
 * pi extension entry point for the Devin (Cognition) provider.
 *
 * Registers the `devin` provider with pi's ExtensionAPI, wiring up:
 *  - OAuth login via Windsurf's browser sign-in flow (`loginDevin`)
 *  - A no-op token refresh (Windsurf api_keys are long-lived)
 *  - A dynamic model catalog via the `refreshModels` hook (pi ≥0.85):
 *    pi calls it at startup, after `/login devin` completes, and whenever
 *    the model registry is refreshed. The fetched catalog is persisted
 *    through `context.publish({ persist })` and restored offline via
 *    `context.stored`.
 *  - `/devin-refresh` command to force a catalog re-fetch
 *  - `/devin-status` command to check auth state
 *  - Streaming chat completions through Devin Cloud (`streamDevin`)
 *
 * The provider uses `streamSimple` — no background proxy. All routing
 * and auth are handled internally via the OAuth-issued api_key.
 */

import type { ExtensionAPI, ModelRegistry, ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type {
    Api,
    Model,
    OAuthCredentials,
    OAuthLoginCallbacks,
    RefreshModelsContext,
} from '@earendil-works/pi-ai';
import { streamDevin } from '../src/stream.js';
import { loginDevin, type DevinOAuthCredentials } from '../src/oauth/login.js';
import {
    buildLiveModels,
    fromStoredModels,
    toStoredModels,
    FALLBACK_MODELS,
    DEFAULT_HOST,
} from '../src/models.js';
import { clearCachedCatalog, getCachedCatalog, isCatalogStale } from '../src/cloud-direct/catalog.js';
import { getApiServerUrlForKey, setApiServerUrlForKey } from '../src/hosts.js';
import { DEFAULT_REGION } from '../src/oauth/types.js';

const PROVIDER_ID = 'devin';
const PROVIDER_NAME = 'Devin (Cognition)';
const OAUTH_NAME = 'Devin (Cognition / Windsurf)';
const API_IDENTIFIER = 'devin-cloud';
// pi requires baseUrl when models are defined, even with streamSimple.
// streamSimple ignores this — it routes internally — but the field must be present.
const PLACEHOLDER_BASE_URL = DEFAULT_HOST;

/**
 * How often the background timer re-checks the catalog while a session is
 * open. Combined with the `session_start` / `agent_settled` triggers this
 * keeps the picker current without any manual `/devin-refresh`.
 */
const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Best-effort background catalog refresh — the "always latest" path.
 *
 * Skips everything when there is no Devin credential, and skips the
 * registry round-trip when the cached catalog is still inside its TTL
 * (unless `force` is set). A successful refresh flows through the normal
 * `refreshModels` path, so the new list is persisted via
 * `context.publish({ persist })` exactly like a manual refresh.
 *
 * Never throws: a failed fetch leaves the persisted/stale catalog in
 * place and chat keeps working on the last-known list.
 */
async function autoRefreshDevinCatalog(
    registry: ModelRegistry,
    force = false,
): Promise<void> {
    try {
        const apiKey = await registry.getApiKeyForProvider(PROVIDER_ID);
        if (!apiKey) return;
        const host = getApiServerUrlForKey(apiKey, DEFAULT_HOST);
        if (!force && !isCatalogStale(apiKey, host)) return;
        await registry.refresh({ providers: [PROVIDER_ID], force });
    } catch {
        // best-effort — see header
    }
}

/**
 * The `refreshModels` implementation (pi ≥0.85 dynamic-catalog hook).
 *
 * Called by pi's model runtime:
 *  - at session startup (`Models.refresh` with the network policy),
 *  - right after `/login devin` persists the new credential,
 *  - after logout / credential changes (with `allowNetwork: false`),
 *  - from `/devin-refresh` (`force: true`).
 *
 * `context.credential` is the effective stored credential — for us an
 * OAuthCredential whose `access` is the api_key. `context.stored` is the
 * catalog snapshot we last persisted via `context.publish({ persist })`.
 */
async function refreshDevinModels(
    context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
    const stored = fromStoredModels(context.stored);

    // Offline / cache-only phase: restore the persisted catalog (or the
    // static fallback when nothing was persisted yet). Never hit the
    // network here — `allowNetwork` is the contract.
    if (!context.allowNetwork) {
        return stored ?? FALLBACK_MODELS;
    }

    const credential = context.credential?.type === 'oauth' ? context.credential : undefined;
    const apiKey = credential?.access;
    if (!apiKey) {
        // Not signed in — nothing to fetch.
        return stored ?? FALLBACK_MODELS;
    }

    // Recover the tenant API server stored on the credential at login
    // (RegisterUser's api_server_url) so EU / FedStart tenants route
    // correctly.
    if (credential && typeof credential.apiServerUrl === 'string') {
        setApiServerUrlForKey(apiKey, credential.apiServerUrl);
    }
    const host = getApiServerUrlForKey(apiKey, DEFAULT_HOST);

    if (context.force) {
        clearCachedCatalog();
    }

    let catalog;
    try {
        catalog = await getCachedCatalog(apiKey, host, context.signal);
    } catch {
        catalog = null;
    }
    if (context.signal.aborted) {
        return stored ?? FALLBACK_MODELS;
    }
    if (!catalog) {
        // Fetch failed — keep the persisted catalog if we have one.
        return stored ?? FALLBACK_MODELS;
    }

    const liveModels = buildLiveModels(catalog);

    // Persist the fresh catalog so offline starts and the post-login
    // offline refresh phase see it via `context.stored`.
    await context.publish({
        persist: {
            models: toStoredModels(liveModels, PROVIDER_ID, API_IDENTIFIER, PLACEHOLDER_BASE_URL),
            checkedAt: Date.now(),
        },
    });

    return liveModels;
}

export default async function (pi: ExtensionAPI): Promise<void> {
    pi.registerProvider(PROVIDER_ID, {
        name: PROVIDER_NAME,
        api: API_IDENTIFIER,
        baseUrl: PLACEHOLDER_BASE_URL,
        models: FALLBACK_MODELS,
        oauth: {
            name: OAUTH_NAME,
            isSubscription: true,
            async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
                const credentials: DevinOAuthCredentials = await loginDevin(callbacks, DEFAULT_REGION);
                // Remember the tenant host for streamDevin, which only ever
                // sees the resolved api key string.
                setApiServerUrlForKey(credentials.access, credentials.apiServerUrl);
                return credentials;
            },
            // Windsurf api_keys are long-lived — nothing to refresh.
            // Signature updated for pi ≥0.85 (`signal` param).
            async refreshToken(
                credentials: OAuthCredentials,
                _signal: AbortSignal,
            ): Promise<OAuthCredentials> {
                return credentials;
            },
            getApiKey(credentials: OAuthCredentials): string {
                return credentials.access;
            },
            modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
                return models;
            },
        },
        refreshModels: refreshDevinModels,
        streamSimple: streamDevin,
    });

    pi.registerCommand('devin-refresh', {
        description: 'Refresh Devin model catalog from Cognition',
        handler: async (_args, ctx) => {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            if (!apiKey) {
                ctx.ui.notify(
                    'Devin: not signed in. Run /login devin',
                    'warning',
                );
                return;
            }
            clearCachedCatalog();
            const result = await ctx.modelRegistry.refresh({
                providers: [PROVIDER_ID],
                force: true,
            });
            const err = result.errors.get(PROVIDER_ID);
            if (err) {
                ctx.ui.notify(`Devin: refresh error - ${err.message}`, 'error');
                return;
            }
            if (result.aborted) {
                ctx.ui.notify('Devin: refresh aborted', 'warning');
                return;
            }
            const count = ctx.modelRegistry
                .getAll()
                .filter((m) => m.provider === PROVIDER_ID).length;
            ctx.ui.notify(`Devin: refreshed ${count} models.`, 'info');
        },
    });

    // --- Always-fresh catalog ----------------------------------------------
    // pi itself calls refreshModels at startup and right after login. These
    // hooks keep the list current for the rest of the session's life:
    //   session_start  — covers new / resume / fork (pi's own startup
    //                    refresh doesn't re-run on those)
    //   agent_settled  — after every run; fetches only when the catalog is
    //                    past its TTL, so a new Cognition model appears in
    //                    the picker without a manual refresh
    //   interval       — catches long idle sessions (picker opened without
    //                    chatting); unref'd so it can't hold the process open
    let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

    pi.on('session_start', (_event, ctx) => {
        void autoRefreshDevinCatalog(ctx.modelRegistry);
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        autoRefreshTimer = setInterval(() => {
            void autoRefreshDevinCatalog(ctx.modelRegistry);
        }, AUTO_REFRESH_INTERVAL_MS);
        autoRefreshTimer.unref();
    });

    pi.on('session_shutdown', () => {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = undefined;
        }
    });

    pi.on('agent_settled', (_event, ctx) => {
        void autoRefreshDevinCatalog(ctx.modelRegistry);
    });

    pi.registerCommand('devin-status', {
        description: 'Show Devin auth status',
        handler: async (_args, ctx) => {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            ctx.ui.notify(
                apiKey ? 'Devin: authenticated' : 'Devin: not signed in. Run /login devin',
                apiKey ? 'info' : 'warning',
            );
        },
    });
}

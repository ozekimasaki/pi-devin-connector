/**
 * In-memory map of api_key → tenant API server URL.
 *
 * `RegisterUser` returns an `api_server_url` per account (default
 * `https://server.codeium.com`; EU / FedStart tenants get their own).
 * We stash it on the OAuth credentials at login, but `streamSimple` only
 * ever receives the resolved api *key* string — not the credential object —
 * so we keep a process-local lookup keyed by api_key.
 *
 * Entries are written by the oauth `login` flow and by `refreshModels`
 * (which sees the full stored credential via `context.credential`).
 * Missing entries fall back to {@link DEFAULT_HOST}.
 */

const keyToHost = new Map<string, string>();

export function setApiServerUrlForKey(apiKey: string, apiServerUrl: string | undefined): void {
    if (!apiKey || !apiServerUrl) return;
    keyToHost.set(apiKey, apiServerUrl);
}

export function getApiServerUrlForKey(apiKey: string, fallback: string): string {
    return keyToHost.get(apiKey) ?? fallback;
}

export function clearApiServerUrls(): void {
    keyToHost.clear();
}

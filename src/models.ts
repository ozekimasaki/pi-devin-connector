/**
 * Model list for the Devin (Cognition) provider.
 *
 * Catalog policy (updated Sept 2026, docs.devin.ai/windsurf/plugins/cascade/models):
 *   - The live `GetCascadeModelConfigs` catalog is ALREADY account-scoped —
 *     entries the account can't run arrive with `disabled: true`. So instead
 *     of the old whitelist (`WANTED_PREFIXES`, which silently dropped every
 *     new family Cognition shipped — swe-2, opus-5, gpt-6-astra, ...), we now
 *     INCLUDE every enabled catalog entry except a small blocklist of
 *     known non-chat utility models ({@link EXCLUDED_PREFIXES}).
 *   - {@link FALLBACK_MODELS} — static entries shown before login or when
 *     the live catalog fetch fails. Real pricing, current catalog.
 *   - {@link MODEL_META} — pricing/context overlay keyed by prefix, so
 *     variants (`claude-opus-4-8-high`, `gpt-5-6-sol-low`) inherit their
 *     family metadata. UIDs ending in `-priority` or `-fast` are billed
 *     2x the family base rates (verified against the docs table).
 *   - UIDs ending in `-none` are no-thinking endpoints -> `reasoning: false`.
 *
 * `refreshModels`-related helpers ({@link toStoredModels} /
 * {@link fromStoredModels}) convert between extension-facing
 * `ProviderModelConfig` and the full `Model<Api>` shape that pi's
 * `ModelsStoreEntry` persists across sessions.
 */

import type { Api, Model, ModelsStoreEntry } from '@earendil-works/pi-ai';
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type { CacheEntry } from './cloud-direct/index.js';

/** Default Cognition/Codeium host. */
const DEFAULT_HOST = 'https://server.codeium.com';

/**
 * Known NON-chat model UIDs in the Cognition catalog — tab autocomplete,
 * grep/check tools, retrieval. Everything else the catalog reports as
 * enabled is surfaced as a chat model, so new families appear
 * automatically without a list update.
 */
export const EXCLUDED_PREFIXES: readonly string[] = [
    'swe-check',
    'swe-grep',
    'swe-1-mini',
    'fast-context',
];

function isExcluded(uid: string): boolean {
    for (const prefix of EXCLUDED_PREFIXES) {
        if (uid === prefix || uid.startsWith(prefix + '-') || uid.startsWith(prefix + '_')) {
            return true;
        }
    }
    return false;
}

/**
 * Per-model metadata + pricing, keyed by prefix (longest match wins).
 *
 * All prices are per million tokens (USD), verified against the official
 * catalog table at docs.devin.ai/windsurf/plugins/cascade/models
 * (Sept 2026). Used by both {@link FALLBACK_MODELS} and
 * {@link buildLiveModels} so there is a single source of truth.
 *
 * Context-window and max-output figures aren't published in that table —
 * values below are per-family estimates consistent with what Windsurf
 * exposes in the IDE.
 */
interface ModelMeta {
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    input: ('text' | 'image')[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}

const MODEL_META: Map<string, ModelMeta> = new Map([
    // ── Cognition in-house SWE family ────────────────────────────────────
    ['swe-2', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
    }],
    ['swe-1-7-lightning', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.50, output: 12.50, cacheRead: 1.00, cacheWrite: 0 },
    }],
    ['swe-1-7', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.50, output: 2.50, cacheRead: 0.20, cacheWrite: 0 },
    }],
    ['swe-1-6', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.50, output: 2.50, cacheRead: 0.20, cacheWrite: 0 },
    }],
    // ── OpenAI GPT family ────────────────────────────────────────────────
    ['gpt-6-astra', {
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
    }],
    ['gpt-5-6-sol', {
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 4.00, output: 20.00, cacheRead: 0.40, cacheWrite: 5.00 },
    }],
    ['gpt-5-6-luna', {
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.20, output: 1.20, cacheRead: 0.02, cacheWrite: 0.25 },
    }],
    ['gpt-5-6-terra', {
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.00, output: 12.00, cacheRead: 0.20, cacheWrite: 2.50 },
    }],
    ['gpt-5-5', {
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 0 },
    }],
    ['gpt-5-4-mini', {
        contextWindow: 400_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.75, output: 4.50, cacheRead: 0.075, cacheWrite: 0 },
    }],
    ['gpt-5-4', {
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 0 },
    }],
    ['gpt-5-3-codex', {
        contextWindow: 400_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.75, output: 14.00, cacheRead: 0.175, cacheWrite: 0 },
    }],
    // ── Anthropic Claude family ──────────────────────────────────────────
    ['claude-opus-5', {
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    }],
    ['claude-opus-4', {
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    }],
    ['opus-4-7-review', {
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    }],
    ['claude-sonnet-5', {
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
    }],
    ['claude-sonnet-4-6', {
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    }],
    ['claude-fable-5-1', {
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 },
    }],
    ['claude-5-fable', {
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
    }],
    // ── Google Gemini family ─────────────────────────────────────────────
    ['gemini-3-1-pro', {
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.00, output: 12.00, cacheRead: 0.20, cacheWrite: 4.50 },
    }],
    ['gemini-3-5-flash', {
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.50, output: 9.00, cacheRead: 0.15, cacheWrite: 1.00 },
    }],
    ['gemini-3-6-flash', {
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.50, output: 7.50, cacheRead: 0.15, cacheWrite: 1.50 },
    }],
    ['gemini-3-7-flash', {
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.50, output: 7.50, cacheRead: 0.15, cacheWrite: 1.50 },
    }],
    // ── Chinese / OSS family ─────────────────────────────────────────────
    ['glm-5-3-flash', {
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.15, output: 0.50, cacheRead: 0.029, cacheWrite: 0 },
    }],
    ['glm-5-3', {
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
    }],
    ['glm-5-2', {
        contextWindow: 1_000_000,
        maxTokens: 131_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
    }],
    ['kimi-k3', {
        contextWindow: 256_000,
        maxTokens: 256_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 },
    }],
    ['kimi-k2-6', {
        contextWindow: 256_000,
        maxTokens: 256_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.95, output: 4.00, cacheRead: 0.16, cacheWrite: 0 },
    }],
    ['kimi-k2-7', {
        contextWindow: 256_000,
        maxTokens: 256_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.95, output: 4.00, cacheRead: 0.19, cacheWrite: 0 },
    }],
    ['deepseek-v4-flash', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
    }],
    ['deepseek-v4-pro', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    }],
    ['nemotron-3-ultra', {
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.60, output: 2.40, cacheRead: 0.12, cacheWrite: 0 },
    }],
    // ── xAI Grok family ──────────────────────────────────────────────────
    ['grok-4-5', {
        contextWindow: 500_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.00, output: 6.00, cacheRead: 0.30, cacheWrite: 0 },
    }],
    ['grok-4-6', {
        contextWindow: 500_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.00, output: 6.00, cacheRead: 0.30, cacheWrite: 0 },
    }],
    // ── Cognition codename / router models ───────────────────────────────
    ['inkling', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
    }],
    ['penguin', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.50, output: 2.50, cacheRead: 0.20, cacheWrite: 0 },
    }],
    ['adaptive', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.50, output: 2.00, cacheRead: 0.10, cacheWrite: 0.50 },
    }],
    ['arena-fast', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.10, output: 0.50, cacheRead: 0, cacheWrite: 0 },
    }],
    ['arena-mixed', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
    }],
    ['arena-smart', {
        contextWindow: 256_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    }],
]);

/**
 * Find the best-matching metadata for a UID by longest-prefix match
 * against {@link MODEL_META}. This lets `gpt-5-6-sol-low` match the
 * `gpt-5-6-sol` entry (parent family) while `glm-5-3-flash-max` matches
 * the more specific `glm-5-3-flash` entry.
 */
function findMeta(uid: string): ModelMeta | undefined {
    let best: { key: string; meta: ModelMeta } | null = null;
    for (const [key, meta] of MODEL_META) {
        if (uid === key || uid.startsWith(key + '-') || uid.startsWith(key + '_')) {
            if (!best || key.length > best.key.length) {
                best = { key, meta };
            }
        }
    }
    return best?.meta;
}

/** Conservative defaults for catalog UIDs not in the override table. */
const DEFAULT_META: ModelMeta = {
    contextWindow: 256_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * `-priority` / `-fast` suffix = Cognition's priority-serving tier, billed
 * at exactly 2x the family's base rates (verified against the docs table:
 * e.g. `gpt-5-6-sol-medium` 4/20 vs `gpt-5-6-sol-medium-priority` 8/40,
 * `claude-opus-4-8-high` 5/25 vs `...-high-fast` 10/50).
 */
function isPriorityVariant(uid: string): boolean {
    return /-(priority|fast)$/.test(uid);
}

/** `-none` suffix = thinking disabled endpoint (e.g. `gpt-5-6-luna-none`). */
function isNoThinkingVariant(uid: string): boolean {
    return /-none(-1m)?$/.test(uid);
}

function makeModel(id: string, name: string, meta: ModelMeta): ProviderModelConfig {
    const fast = isPriorityVariant(id);
    return {
        id,
        name,
        reasoning: isNoThinkingVariant(id) ? false : meta.reasoning,
        input: meta.input,
        cost: fast
            ? {
                input: meta.cost.input * 2,
                output: meta.cost.output * 2,
                cacheRead: meta.cost.cacheRead * 2,
                cacheWrite: meta.cost.cacheWrite * 2,
            }
            : meta.cost,
        contextWindow: meta.contextWindow,
        maxTokens: meta.maxTokens,
    };
}

/**
 * Static fallback list — current catalog flagships with real pricing.
 * Shown before login or when the live catalog fetch fails.
 */
export const FALLBACK_MODELS: ProviderModelConfig[] = [
    makeModel('swe-2-high', 'SWE-2 High', MODEL_META.get('swe-2')!),
    makeModel('swe-2-max', 'SWE-2 Max', MODEL_META.get('swe-2')!),
    makeModel('swe-2-medium', 'SWE-2 Medium', MODEL_META.get('swe-2')!),
    makeModel('swe-1-7', 'SWE-1.7 Max', MODEL_META.get('swe-1-7')!),
    makeModel('swe-1-7-lightning', 'SWE-1.7 Lightning Max', MODEL_META.get('swe-1-7-lightning')!),
    makeModel('swe-1-6', 'SWE-1.6', MODEL_META.get('swe-1-6')!),
    makeModel('claude-opus-5-medium', 'Claude Opus 5 Medium', MODEL_META.get('claude-opus-5')!),
    makeModel('claude-sonnet-5-medium', 'Claude Sonnet 5 Medium', MODEL_META.get('claude-sonnet-5')!),
    makeModel('claude-fable-5-1-medium', 'Claude Fable 5.1 Medium', MODEL_META.get('claude-fable-5-1')!),
    makeModel('gpt-6-astra-medium', 'GPT-6 Astra Medium', MODEL_META.get('gpt-6-astra')!),
    makeModel('gpt-5-6-sol-medium', 'GPT-5.6 Sol Medium', MODEL_META.get('gpt-5-6-sol')!),
    makeModel('gpt-5-6-luna-medium', 'GPT-5.6 Luna Medium', MODEL_META.get('gpt-5-6-luna')!),
    makeModel('gemini-3-7-flash-medium', 'Gemini 3.7 Flash Medium', MODEL_META.get('gemini-3-7-flash')!),
    makeModel('glm-5-3-max', 'GLM-5.3 Max', MODEL_META.get('glm-5-3')!),
    makeModel('kimi-k3-high', 'Kimi K3 High', MODEL_META.get('kimi-k3')!),
    makeModel('deepseek-v4-pro-max', 'DeepSeek V4 Pro Max', MODEL_META.get('deepseek-v4-pro')!),
    makeModel('grok-4-6-medium', 'Grok 4.6 Medium', MODEL_META.get('grok-4-6')!),
    makeModel('adaptive', 'Adaptive', MODEL_META.get('adaptive')!),
];

/**
 * Build the model list from a live catalog response.
 *
 * Includes every non-disabled entry except {@link EXCLUDED_PREFIXES}
 * (known non-chat utility models), stamping each with pricing/metadata
 * from {@link MODEL_META} via longest-prefix match — unknown UIDs get
 * {@link DEFAULT_META}. Priority (`-priority`/`-fast`) variants are billed
 * at 2x family rates; `-none` variants are marked non-reasoning.
 *
 * Falls back to {@link FALLBACK_MODELS} when the catalog is null, empty,
 * or contains nothing usable.
 */
export function buildLiveModels(catalog: CacheEntry | null): ProviderModelConfig[] {
    if (!catalog || catalog.byUid.size === 0) {
        return FALLBACK_MODELS;
    }

    const models: ProviderModelConfig[] = [];
    for (const entry of catalog.byUid.values()) {
        if (entry.disabled) continue;
        if (isExcluded(entry.modelUid)) continue;
        const meta = findMeta(entry.modelUid) ?? DEFAULT_META;
        models.push(makeModel(entry.modelUid, entry.label || entry.modelUid, meta));
    }

    if (models.length === 0) {
        return FALLBACK_MODELS;
    }

    return models;
}

// ----------------------------------------------------------------------------
// ModelsStoreEntry conversion — for ProviderConfig.refreshModels publish/restore
// ----------------------------------------------------------------------------

/**
 * Stamp extension model configs into full `Model<Api>` objects suitable for
 * `context.publish({ persist: { models } })`. `api`, `provider`, and
 * `baseUrl` are required on the stored shape but not on ProviderModelConfig.
 */
export function toStoredModels(
    configs: ProviderModelConfig[],
    providerId: string,
    api: Api,
    baseUrl: string,
): Model<Api>[] {
    return configs.map((c) => ({
        id: c.id,
        name: c.name,
        api: c.api ?? api,
        provider: providerId,
        baseUrl: c.baseUrl ?? baseUrl,
        reasoning: c.reasoning,
        thinkingLevelMap: c.thinkingLevelMap,
        input: c.input,
        cost: c.cost,
        contextWindow: c.contextWindow,
        maxTokens: c.maxTokens,
        headers: c.headers,
    }));
}

/**
 * Restore a persisted `ModelsStoreEntry` into `ProviderModelConfig[]` —
 * the inverse of {@link toStoredModels}. Used by `refreshModels` when the
 * network is unavailable (`context.allowNetwork === false`) so the stored
 * catalog survives offline starts. Returns `undefined` when nothing was
 * stored.
 */
export function fromStoredModels(
    stored: Readonly<ModelsStoreEntry> | undefined,
): ProviderModelConfig[] | undefined {
    if (!stored || stored.models.length === 0) return undefined;
    return stored.models.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        thinkingLevelMap: m.thinkingLevelMap,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        headers: m.headers,
    }));
}

export { DEFAULT_HOST };

/**
 * Unit tests for the Devin provider's pure/edge paths.
 *
 * Covers:
 *  - streamDevin: error path when no API key is configured
 *  - mapContextToChat: pi Context -> ChatHistoryItem/ToolDef mapping
 *  - buildLiveModels: catalog filtering + fallback behavior
 *  - toStoredModels/fromStoredModels: refreshModels persist round-trip
 *  - wire helpers: varint + Connect-streaming envelope round-trip
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { streamDevin } from '../src/stream.js';
import { mapContextToChat } from '../src/context-map.js';
import {
    buildLiveModels,
    fromStoredModels,
    toStoredModels,
    FALLBACK_MODELS,
} from '../src/models.js';
import {
    encodeString,
    encodeVarint,
    encodeVarintField,
    decodeVarint,
    iterFields,
    frameConnectStream,
    parseConnectFrames,
} from '../src/cloud-direct/wire.js';
import type { CacheEntry } from '../src/cloud-direct/index.js';

const TEST_MODEL: Model<Api> = {
    id: 'swe-1-7',
    name: 'SWE-1.7',
    api: 'devin-cloud',
    provider: 'devin',
    baseUrl: 'https://server.codeium.com',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 128_000,
};

function makeContext(messages: Context['messages']): Context {
    return { systemPrompt: 'sys', messages, tools: [] };
}

describe('streamDevin', () => {
    it('emits an error event when no API key is configured', async () => {
        const stream = streamDevin(TEST_MODEL, makeContext([]), undefined);
        const events = [];
        for await (const ev of stream) events.push(ev);
        const last = events[events.length - 1];
        assert.equal(last.type, 'error');
        if (last.type === 'error') {
            assert.equal(last.reason, 'error');
            assert.match(last.error.errorMessage ?? '', /API key/);
        }
    });
});

describe('mapContextToChat', () => {
    it('maps system prompt, user text, assistant text+toolCall, toolResult', () => {
        const ctx: Context = {
            systemPrompt: 'You are helpful.',
            messages: [
                { role: 'user', content: 'hi', timestamp: 1 },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'hmm' },
                        { type: 'text', text: 'let me check' },
                        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { cmd: 'ls' } },
                    ],
                    api: 'devin-cloud',
                    provider: 'devin',
                    model: 'swe-1-7',
                    usage: {
                        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: 'toolUse',
                    timestamp: 2,
                },
                {
                    role: 'toolResult',
                    toolCallId: 'c1',
                    toolName: 'bash',
                    content: [{ type: 'text', text: 'file.txt' }],
                    isError: false,
                    timestamp: 3,
                },
            ],
            tools: [
                { name: 'bash', description: 'run a command', parameters: { type: 'object' } },
            ],
        };

        const { messages, tools } = mapContextToChat(ctx);
        assert.equal(messages.length, 4);
        assert.deepEqual(messages[0], { role: 'system', content: 'You are helpful.' });
        assert.deepEqual(messages[1], { role: 'user', content: 'hi' });
        assert.equal(messages[2].role, 'assistant');
        assert.equal(messages[2].content, 'let me check');
        assert.deepEqual(messages[2].tool_calls, [
            { id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
        ]);
        assert.deepEqual(messages[3], {
            role: 'tool',
            content: [{ type: 'text', text: 'file.txt' }],
            tool_call_id: 'c1',
        });
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, 'bash');
    });

    it('keeps image parts on user messages', () => {
        const { messages } = mapContextToChat({
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'look' },
                        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
                    ],
                    timestamp: 1,
                },
            ],
        });
        assert.deepEqual(messages[0].content, [
            { type: 'text', text: 'look' },
            { type: 'image', mimeType: 'image/png', base64Data: 'QUJD' },
        ]);
    });
});

function catalogOf(entries: Array<[string, string, boolean]>): CacheEntry {
    const byUid = new Map(
        entries.map(([uid, label, disabled]) => [uid, { modelUid: uid, label, disabled }]),
    );
    return { byUid, fetchedAt: Date.now(), apiKey: 'k', host: 'h' };
}

describe('buildLiveModels', () => {
    it('includes unknown families, skips disabled and non-chat entries', () => {
        const models = buildLiveModels(catalogOf([
            ['swe-2-high', 'SWE-2 High', false],
            ['swe-2-max', 'SWE-2 Max', false],
            ['claude-opus-4-8', 'Opus', true],       // disabled — dropped
            ['swe-check', 'SWE-check', false],        // non-chat tool — dropped
            ['swe-grep', 'swe-grep', false],          // non-chat tool — dropped
            ['future-model-9-turbo', 'Future 9', false], // unknown family — kept
        ]));
        assert.deepEqual(
            models.map((m) => m.id),
            ['swe-2-high', 'swe-2-max', 'future-model-9-turbo'],
        );
        assert.equal(models[0].cost.output, 3.75);   // swe-2 family meta
        assert.equal(models[2].cost.output, 0);      // DEFAULT_META fallback
    });

    it('doubles cost for -priority/-fast variants and marks -none non-reasoning', () => {
        const models = buildLiveModels(catalogOf([
            ['gpt-5-6-sol-medium', 'Sol Medium', false],
            ['gpt-5-6-sol-medium-priority', 'Sol Medium Fast', false],
            ['gpt-5-6-luna-none', 'Luna None', false],
        ]));
        const [base, fast, none] = models;
        assert.equal(base.cost.input, 4);
        assert.equal(fast.cost.input, 8);            // 2x priority tier
        assert.equal(fast.cost.output, 40);
        assert.equal(none.reasoning, false);
        assert.equal(base.reasoning, true);
    });

    it('falls back to FALLBACK_MODELS on empty catalogs', () => {
        assert.equal(buildLiveModels(null), FALLBACK_MODELS);
        assert.equal(buildLiveModels(catalogOf([])), FALLBACK_MODELS);
        assert.equal(
            buildLiveModels(catalogOf([['swe-check', 'X', false]])),
            FALLBACK_MODELS,
        );
    });
});

describe('stored-model round-trip (refreshModels persistence)', () => {
    it('toStoredModels stamps api/provider/baseUrl; fromStoredModels restores', () => {
        const stored = toStoredModels(FALLBACK_MODELS, 'devin', 'devin-cloud', 'https://server.codeium.com');
        assert.equal(stored[0].provider, 'devin');
        assert.equal(stored[0].api, 'devin-cloud');
        const restored = fromStoredModels({ models: stored });
        assert.equal(restored?.length, FALLBACK_MODELS.length);
        assert.equal(restored?.[0].id, FALLBACK_MODELS[0].id);
        assert.equal(restored?.[0].cost.output, FALLBACK_MODELS[0].cost.output);
    });

    it('fromStoredModels returns undefined for empty storage', () => {
        assert.equal(fromStoredModels(undefined), undefined);
        assert.equal(fromStoredModels({ models: [] }), undefined);
    });
});

describe('wire helpers', () => {
    it('varint round-trips', () => {
        for (const n of [0n, 1n, 127n, 128n, 300n, 2n ** 40n]) {
            const enc = encodeVarint(n);
            const [v, off] = decodeVarint(enc, 0);
            assert.equal(v, n);
            assert.equal(off, enc.length);
        }
    });

    it('Connect-streaming envelope round-trips (gzip)', () => {
        const body = Buffer.concat([encodeString(1, 'hello'), encodeVarintField(2, 42n)]);
        const framed = frameConnectStream(body, true);
        const frames = parseConnectFrames(framed);
        assert.equal(frames.length, 1);
        assert.equal(frames[0].eos, false);
        const fields = [...iterFields(frames[0].payload)];
        assert.equal(fields[0].num, 1);
        assert.equal((fields[0].value as Buffer).toString(), 'hello');
        assert.equal(fields[1].num, 2);
        assert.equal(fields[1].value, 42n);
    });

    it('encodeVarint rejects negatives', () => {
        assert.throws(() => encodeVarint(-1), RangeError);
    });
});

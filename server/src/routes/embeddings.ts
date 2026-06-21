import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';

export const embeddingsRouter = Router();

// Timing-safe key comparison
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

const embeddingSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
});

// Embedding model catalog — platform -> model_id -> display
const EMBEDDING_MODELS: Record<string, { platform: string; modelId: string; dimensions: number }> = {
  // Google
  'text-embedding-004':          { platform: 'google',  modelId: 'text-embedding-004',          dimensions: 768 },
  'text-multilingual-embedding-002': { platform: 'google', modelId: 'text-multilingual-embedding-002', dimensions: 768 },
  // Mistral
  'mistral-embed':               { platform: 'mistral', modelId: 'mistral-embed',               dimensions: 1024 },
  // Auto — try Google first, fall back to Mistral
  'auto':                        { platform: 'google',  modelId: 'text-embedding-004',          dimensions: 768 },
};

const DEFAULT_EMBED_MODEL = 'text-embedding-004';

async function embedGoogle(
  apiKey: string,
  modelId: string,
  inputs: string[],
  dimensions?: number,
): Promise<number[][]> {
  // Use embedContent for single, batchEmbedContents for multiple
  if (inputs.length === 1) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:embedContent?key=${apiKey}`;
    const body: Record<string, unknown> = {
      model: `models/${modelId}`,
      content: { parts: [{ text: inputs[0] }] },
    };
    if (dimensions) body.outputDimensionality = dimensions;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Google Embeddings error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as { embedding: { values: number[] } };
    return [data.embedding.values];
  }

  // Batch endpoint
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:batchEmbedContents?key=${apiKey}`;
  const body: Record<string, unknown> = {
    requests: inputs.map(text => ({
      model: `models/${modelId}`,
      content: { parts: [{ text }] },
      ...(dimensions ? { outputDimensionality: dimensions } : {}),
    })),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Google Embeddings error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
  }

  const data = await res.json() as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map(e => e.values);
}

async function embedMistral(
  apiKey: string,
  modelId: string,
  inputs: string[],
): Promise<number[][]> {
  const res = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: modelId, input: inputs }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Mistral Embeddings error ${res.status}: ${(err as any).message ?? res.statusText}`);
  }

  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map(d => d.embedding);
}

embeddingsRouter.post('/', async (req: Request, res: Response) => {
  // Auth
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const parsed = embeddingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`, type: 'invalid_request_error' },
    });
    return;
  }

  const { input, model: requestedModel, dimensions } = parsed.data;
  const inputs = Array.isArray(input) ? input : [input];
  const modelKey = requestedModel ?? DEFAULT_EMBED_MODEL;
  const catalog = EMBEDDING_MODELS[modelKey] ?? EMBEDDING_MODELS[DEFAULT_EMBED_MODEL];

  const db = getDb();

  // Get a healthy key for the platform
  const keyRow = db.prepare(
    `SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != 'invalid' LIMIT 1`
  ).get(catalog.platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;

  // If primary platform has no key and model is auto, try fallback
  let activePlatform = catalog.platform;
  let activeModelId = catalog.modelId;
  let activeKey = keyRow;

  if (!activeKey && modelKey === 'auto') {
    // Try Mistral as fallback
    const mistralKey = db.prepare(
      `SELECT * FROM api_keys WHERE platform = 'mistral' AND enabled = 1 AND status != 'invalid' LIMIT 1`
    ).get() as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (mistralKey) {
      activePlatform = 'mistral';
      activeModelId = 'mistral-embed';
      activeKey = mistralKey;
    }
  }

  if (!activeKey) {
    res.status(429).json({
      error: {
        message: `No available API key for embeddings. Add a Google or Mistral key in the dashboard.`,
        type: 'routing_error',
      },
    });
    return;
  }

  const apiKey = decrypt(activeKey.encrypted_key, activeKey.iv, activeKey.auth_tag);

  try {
    let vectors: number[][];

    if (activePlatform === 'google') {
      vectors = await embedGoogle(apiKey, activeModelId, inputs, dimensions);
    } else if (activePlatform === 'mistral') {
      vectors = await embedMistral(apiKey, activeModelId, inputs);
    } else {
      throw new Error(`Unsupported embedding platform: ${activePlatform}`);
    }

    const outputDimensions = dimensions ?? catalog.dimensions;

    res.json({
      object: 'list',
      data: vectors.map((embedding, index) => ({
        object: 'embedding',
        index,
        embedding,
      })),
      model: activeModelId,
      usage: {
        prompt_tokens: inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
        total_tokens: inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
      },
      _routed_via: `${activePlatform}/${activeModelId}`,
      dimensions: outputDimensions,
    });
  } catch (err: any) {
    res.status(502).json({
      error: { message: `Embedding error: ${err.message}`, type: 'provider_error' },
    });
  }
});

// List available embedding models
embeddingsRouter.get('/models', (_req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: Object.entries(EMBEDDING_MODELS)
      .filter(([key]) => key !== 'auto')
      .map(([id, info]) => ({
        id,
        object: 'model',
        owned_by: info.platform,
        dimensions: info.dimensions,
      })),
  });
});

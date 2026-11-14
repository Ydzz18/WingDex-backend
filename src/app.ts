import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import multer, { MulterError } from 'multer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { IdentificationResult } from './gemini.js';
import { createAdminRouter } from './admin.js';
import { createEbirdRouter, createEbirdTaxonomyLookup } from './ebird.js';
import { createRegionalAchievementsRouter } from './regionalAchievements.js';
import type { RegionalChecklistSnapshot } from './regionalChecklists.js';

const maximumPhotoBytes = 10 * 1024 * 1024;
const maximumTaxonomyWaitMs = 1_000;
const supportedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export type IdentifyPhoto = (
  image: Buffer,
  mimeType: string
) => Promise<IdentificationResult>;

class UnsupportedImageError extends Error {}

export function createApp(options: {
  identifyPhoto: IdentifyPhoto;
  corsOrigins?: string;
  ebird?: {
    apiKey?: string;
    fetch?: typeof fetch;
    getSupabase?: () => SupabaseClient;
  };
  admin?: {
    getSupabase?: () => SupabaseClient;
    adminUserIds?: string;
    refreshChecklist?: (regionCode: string) => Promise<RegionalChecklistSnapshot>;
  };
  regionalAchievements?: {
    getSupabase?: () => SupabaseClient;
  };
}) {
  const app = express();
  app.set('trust proxy', 1);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maximumPhotoBytes, files: 1, fields: 0 },
    fileFilter: (_request, file, callback) => {
      if (!supportedMimeTypes.has(file.mimetype)) {
        callback(new UnsupportedImageError('Unsupported image type.'));
        return;
      }
      callback(null, true);
    },
  });
  const identifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many identification requests. Try again later.' },
  });
  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many admin requests. Try again shortly.' },
  });
  const ebirdLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many eBird requests. Try again shortly.' },
  });
  const regionalProgressLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Regional rank sync limit reached. Try again shortly.' },
  });
  const allowedOrigins = options.corsOrigins
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const ebirdTaxonomyLookup = createEbirdTaxonomyLookup(options.ebird);

  app.use(cors({ origin: allowedOrigins?.length ? allowedOrigins : '*' }));
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use('/admin', adminLimiter, createAdminRouter({
    ...options.admin,
    ebirdApiKey: options.ebird?.apiKey,
    fetch: options.ebird?.fetch,
  }));
  app.use('/ebird', ebirdLimiter, createEbirdRouter(options.ebird, ebirdTaxonomyLookup));
  app.use('/regional-ranks', regionalProgressLimiter, createRegionalAchievementsRouter({
    getSupabase: options.regionalAchievements?.getSupabase ?? options.ebird?.getSupabase,
  }));
  app.post('/identify', identifyLimiter, upload.single('photo'), async (request, response, next) => {
    if (!request.file) {
      response.status(400).json({ error: 'Choose a photo to identify.' });
      return;
    }

    try {
      const result = await options.identifyPhoto(request.file.buffer, request.file.mimetype);
      if (!result.commonName && !result.scientificName) {
        response.json(result);
        return;
      }

      const taxonomyPromise = ebirdTaxonomyLookup.getTaxonomy().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const taxonomyResult = await Promise.race([
        taxonomyPromise,
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => resolve(null), maximumTaxonomyWaitMs);
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (!taxonomyResult) {
        response.json({ ...result, ebirdSpecies: null });
        return;
      }

      try {
        if (!taxonomyResult.ok) throw taxonomyResult.error;
        const ebirdSpecies = await ebirdTaxonomyLookup.findByName(result.commonName, result.scientificName);
        response.json({ ...result, ebirdSpecies });
      } catch (error) {
        response.json({
          ...result,
          ebirdSpecies: null,
          ebirdLookupError: error instanceof Error
            ? error.message
            : 'Could not load matching eBird species details.',
        });
      }
    } catch (error) {
      next(error);
    }
  });

  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof UnsupportedImageError) {
      response.status(415).json({ error: 'Use a JPEG, PNG, WebP, HEIC, or HEIF photo.' });
      return;
    }

    if (error instanceof MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      response.status(status).json({
        error: status === 413 ? 'Photo must be 10 MB or smaller.' : 'Upload one photo in the photo field.',
      });
      return;
    }

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      response.status(504).json({ error: 'Bird identification timed out. Try again with a smaller, clearer photo.' });
      return;
    }

    response.status(502).json({ error: 'Identification could not be completed. Try again later.' });
  };
  app.use(handleError);

  return app;
}
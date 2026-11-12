import { Router } from 'express';
import { z } from 'zod';

const apiBaseUrl = 'https://api.ebird.org/v2';
const taxonomyCacheTtl = 6 * 60 * 60 * 1000;
const observationCacheTtl = 60 * 1000;
const hotspotCacheTtl = 5 * 60 * 1000;

export type EbirdTaxon = {
  speciesCode: string;
  comName: string;
  sciName: string;
  category: string;
  familyCode?: string;
  familyComName?: string;
  familySciName?: string;
  order?: string;
};

type CachedResponse = { expiresAt: number; body: unknown };

const taxonomyQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const geoQuerySchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  dist: z.coerce.number().finite().min(1).max(50).default(25),
  back: z.coerce.number().int().min(1).max(30).default(14),
  maxResults: z.coerce.number().int().min(1).max(100).default(50),
});
const speciesCodeSchema = z.string().regex(/^[a-z0-9]{2,12}$/i);
const regionCodeSchema = z.string().regex(/^[A-Z]{2,3}(?:-[A-Z0-9]{1,6}){0,3}$/i);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

class EbirdRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createEbirdTaxonomyLookup(options: { apiKey?: string; fetch?: typeof fetch } = {}) {
  const apiKey = options.apiKey?.trim();
  const request = options.fetch ?? fetch;
  let cachedTaxonomy: { expiresAt: number; taxonomy: EbirdTaxon[] } | undefined;

  async function getTaxonomy(): Promise<EbirdTaxon[]> {
    if (!apiKey) {
      throw new EbirdRequestError(503, 'eBird data is unavailable. Configure EBIRD_API_KEY on the backend.');
    }
    if (cachedTaxonomy && cachedTaxonomy.expiresAt > Date.now()) return cachedTaxonomy.taxonomy;

    let response: Response;
    try {
      response = await request(
        `${apiBaseUrl}/ref/taxonomy/ebird?fmt=json&locale=en&cat=species`,
        {
          headers: { 'X-eBirdApiToken': apiKey },
          signal: AbortSignal.timeout(12_000),
        },
      );
    } catch {
      throw new EbirdRequestError(502, 'Could not reach eBird. Please try again.');
    }
    if (response.status === 429) {
      throw new EbirdRequestError(429, 'eBird request limit reached. Please try again later.');
    }
    if (!response.ok) {
      throw new EbirdRequestError(502, 'eBird could not complete this request. Please try again.');
    }

    let taxonomy: unknown;
    try {
      taxonomy = await response.json();
    } catch {
      throw new EbirdRequestError(502, 'eBird returned an unreadable species taxonomy.');
    }
    if (!Array.isArray(taxonomy)) {
      throw new EbirdRequestError(502, 'eBird returned an invalid species taxonomy.');
    }
    cachedTaxonomy = { expiresAt: Date.now() + taxonomyCacheTtl, taxonomy: taxonomy as EbirdTaxon[] };
    return cachedTaxonomy.taxonomy;
  }

  const normalizeName = (name: string) => name.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');

  return {
    getTaxonomy,
    async findByName(commonName: string | null, scientificName: string | null) {
      const taxonomy = await getTaxonomy();
      const normalizedScientificName = scientificName ? normalizeName(scientificName) : '';
      const normalizedCommonName = commonName ? normalizeName(commonName) : '';
      return taxonomy.find((bird) =>
        normalizedScientificName && normalizeName(bird.sciName) === normalizedScientificName
      ) ?? taxonomy.find((bird) =>
        normalizedCommonName && normalizeName(bird.comName) === normalizedCommonName
      ) ?? null;
    },
    async findBySpeciesCode(speciesCode: string) {
      const taxonomy = await getTaxonomy();
      return taxonomy.find((bird) => bird.speciesCode.toLowerCase() === speciesCode.toLowerCase()) ?? null;
    },
  };
}

export function createEbirdRouter(
  options: { apiKey?: string; fetch?: typeof fetch } = {},
  taxonomyLookup = createEbirdTaxonomyLookup(options),
) {
  const router = Router();
  const apiKey = options.apiKey?.trim();
  const request = options.fetch ?? fetch;
  const cache = new Map<string, CachedResponse>();

  async function getJson<T>(path: string, params: URLSearchParams, ttl: number): Promise<T> {
    if (!apiKey) {
      throw new EbirdRequestError(503, 'eBird data is unavailable. Configure EBIRD_API_KEY on the backend.');
    }

    const url = new URL(`${apiBaseUrl}${path}`);
    url.search = params.toString();
    const cacheKey = url.toString();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.body as T;

    let response: Response;
    try {
      response = await request(url, {
        headers: { 'X-eBirdApiToken': apiKey },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new EbirdRequestError(502, 'Could not reach eBird. Please try again.');
    }

    if (response.status === 429) {
      throw new EbirdRequestError(429, 'eBird request limit reached. Please try again later.');
    }
    if (!response.ok) {
      throw new EbirdRequestError(502, 'eBird could not complete this request. Please try again.');
    }

    let body: T;
    try {
      body = await response.json() as T;
    } catch {
      throw new EbirdRequestError(502, 'eBird returned an unreadable response.');
    }
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= Date.now()) cache.delete(key);
    }
    while (cache.size >= 256) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
    cache.set(cacheKey, { expiresAt: Date.now() + ttl, body });
    return body;
  }

  async function getList<T>(path: string, params: URLSearchParams, ttl: number): Promise<T[]> {
    const body = await getJson<unknown>(path, params, ttl);
    if (!Array.isArray(body)) throw new EbirdRequestError(502, 'eBird returned an invalid list.');
    return body as T[];
  }

  async function handle(
    response: import('express').Response,
    action: () => Promise<unknown>,
  ) {
    try {
      response.json(await action());
    } catch (error) {
      if (error instanceof EbirdRequestError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      response.status(502).json({ error: 'Could not load eBird data. Please try again.' });
    }
  }

  router.get('/taxonomy', (request, response) => {
    const parsed = taxonomyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: 'Enter at least two characters to search species.' });
      return;
    }
    const { q, limit } = parsed.data;
    void handle(response, async () => {
      const taxonomy = await taxonomyLookup.getTaxonomy();
      const normalizedQuery = q.toLocaleLowerCase();
      return taxonomy
        .filter((bird) => [
          bird.comName,
          bird.sciName,
          bird.familyComName ?? '',
          bird.familySciName ?? '',
        ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
        .slice(0, limit);
    });
  });

  router.get('/species/:speciesCode', (request, response) => {
    const parsedCode = speciesCodeSchema.safeParse(request.params.speciesCode);
    if (!parsedCode.success) {
      response.status(400).json({ error: 'Invalid eBird species code.' });
      return;
    }
    const speciesCode = parsedCode.data;
    void handle(response, async () => {
      const species = await taxonomyLookup.findBySpeciesCode(speciesCode);
      if (!species) throw new EbirdRequestError(404, 'Species not found in eBird taxonomy.');
      return species;
    });
  });

  router.get('/species/:speciesCode/observations', (request, response) => {
    const parsedCode = speciesCodeSchema.safeParse(request.params.speciesCode);
    const parsedQuery = geoQuerySchema.safeParse(request.query);
    if (!parsedCode.success || !parsedQuery.success) {
      response.status(400).json({ error: 'A valid species code and latitude/longitude are required.' });
      return;
    }
    const { lat, lng, dist, back, maxResults } = parsedQuery.data;
    const params = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      dist: String(dist),
      back: String(back),
      maxResults: String(maxResults),
    });
    void handle(response, () => getList(
      `/data/nearest/obs/${parsedCode.data}`,
      params,
      observationCacheTtl,
    ));
  });

  router.get('/observations/nearby', (request, response) => {
    const parsed = geoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: 'A valid latitude and longitude are required.' });
      return;
    }
    const { lat, lng, dist, back, maxResults } = parsed.data;
    const params = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      dist: String(dist),
      back: String(back),
      maxResults: String(maxResults),
    });
    void handle(response, () => getList('/data/obs/geo/recent', params, observationCacheTtl));
  });

  router.get('/observations/:regionCode/recent', (request, response) => {
    const parsedRegion = regionCodeSchema.safeParse(request.params.regionCode);
    const back = z.coerce.number().int().min(1).max(30).safeParse(request.query.back ?? 14);
    const maxResults = z.coerce.number().int().min(1).max(100).safeParse(request.query.maxResults ?? 50);
    if (!parsedRegion.success || !back.success || !maxResults.success) {
      response.status(400).json({ error: 'A valid eBird region code is required.' });
      return;
    }
    const params = new URLSearchParams({ back: String(back.data), maxResults: String(maxResults.data) });
    void handle(response, () => getList(
      `/data/obs/${encodeURIComponent(parsedRegion.data)}/recent`,
      params,
      observationCacheTtl,
    ));
  });

  router.get('/checklists/:regionCode/:date', (request, response) => {
    const parsedRegion = regionCodeSchema.safeParse(request.params.regionCode);
    const parsedDate = dateSchema.safeParse(request.params.date);
    if (!parsedRegion.success || !parsedDate.success) {
      response.status(400).json({ error: 'A valid eBird region code and YYYY-MM-DD date are required.' });
      return;
    }
    const [year, month, day] = parsedDate.data.split('-');
    const path = `/product/lists/${encodeURIComponent(parsedRegion.data)}/${year}/${month}/${day}`;
    void handle(response, () => getList(path, new URLSearchParams({ maxResults: '50' }), observationCacheTtl));
  });

  router.get('/hotspots/nearby', (request, response) => {
    const parsed = geoQuerySchema.pick({ lat: true, lng: true, dist: true }).safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: 'A valid latitude and longitude are required.' });
      return;
    }
    const params = new URLSearchParams({
      lat: String(parsed.data.lat),
      lng: String(parsed.data.lng),
      dist: String(parsed.data.dist),
    });
    void handle(response, () => getList('/ref/hotspot/geo', params, hotspotCacheTtl));
  });

  return router;
}

import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from './app.js';
import { createEbirdTaxonomyLookup } from './ebird.js';
import { checklistHash } from './regionalChecklists.js';

const identifyPhoto = vi.fn();

function createFetchMock(body: unknown = [], status = 200) {
  const calls: { url: string; token: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      token: new Headers(init?.headers).get('x-ebirdapitoken'),
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetcher, calls };
}

function appFor(
  fetch?: typeof globalThis.fetch,
  getSupabase?: () => SupabaseClient,
) {
  return createApp({
    identifyPhoto,
    ebird: { apiKey: 'test-ebird-key', fetch, getSupabase },
  });
}

function checklistStore(row: Record<string, unknown>) {
  return (() => ({
    from() {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        async maybeSingle() { return { data: row, error: null }; },
      };
      return builder;
    },
  })) as unknown as () => SupabaseClient;
}

describe('eBird API proxy', () => {
  it('shares an in-flight taxonomy fetch across simultaneous lookups', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetcher: typeof fetch = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const taxonomyLookup = createEbirdTaxonomyLookup({ apiKey: 'test-ebird-key', fetch: fetcher });

    const firstLookup = taxonomyLookup.getTaxonomy();
    const secondLookup = taxonomyLookup.getTaxonomy();

    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFetch(new Response(JSON.stringify([
      { speciesCode: 'amerob', comName: 'American Robin', sciName: 'Turdus migratorius', category: 'species' },
    ])));
    await expect(Promise.all([firstLookup, secondLookup])).resolves.toHaveLength(2);
  });

  it('requires an eBird key without revealing upstream credentials', async () => {
    const app = createApp({ identifyPhoto });
    const response = await request(app).get('/ebird/taxonomy?q=robin');
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('EBIRD_API_KEY');
  });

  it('searches and filters the cached eBird taxonomy server-side', async () => {
    const { fetcher, calls } = createFetchMock([
        { speciesCode: 'amerob', comName: 'American Robin', sciName: 'Turdus migratorius', category: 'species' },
        { speciesCode: 'amecro', comName: 'American Crow', sciName: 'Corvus brachyrhynchos', category: 'species' },
      ]);
    const app = appFor(fetcher);
    const response = await request(app).get('/ebird/taxonomy?q=robin');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].speciesCode).toBe('amerob');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/ref/taxonomy/ebird?fmt=json&locale=en&cat=species');
    expect(calls[0].token).toBe('test-ebird-key');
    const cachedResponse = await request(app).get('/ebird/taxonomy?q=crow');
    expect(cachedResponse.body).toHaveLength(1);
    expect(cachedResponse.body[0].speciesCode).toBe('amecro');
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid coordinates before contacting eBird', async () => {
    const { fetcher, calls } = createFetchMock();
    const response = await request(appFor(fetcher))
      .get('/ebird/observations/nearby?lat=91&lng=0');
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('fetches nearby observations and hotspots from the location', async () => {
    const { fetcher, calls } = createFetchMock();
    const app = appFor(fetcher);
    const sightings = await request(app).get('/ebird/observations/nearby?lat=45.5&lng=-122.6');
    const hotspots = await request(app).get('/ebird/hotspots/nearby?lat=45.5&lng=-122.6');

    expect(sightings.status).toBe(200);
    expect(hotspots.status).toBe(200);
    expect(calls[0].url).toContain('/data/obs/geo/recent');
    expect(calls[1].url).toContain('/ref/hotspot/geo');
    expect(new URL(calls[1].url).searchParams.get('fmt')).toBe('json');
  });

  it('serves regional recent checklists through the eBird products API', async () => {
    const { fetcher, calls } = createFetchMock();
    const response = await request(appFor(fetcher)).get('/ebird/checklists/US-OR/2026-11-11');
    expect(response.status).toBe(200);
    expect(calls[0].url).toContain('/product/lists/US-OR/2026/11/11');
  });

  it('maps upstream errors without returning credentials or response bodies', async () => {
    const { fetcher } = createFetchMock('private upstream details', 403);
    const response = await request(appFor(fetcher)).get('/ebird/taxonomy?q=robin');
    expect(response.status).toBe(502);
    expect(response.text).not.toContain('private upstream details');
    expect(response.text).not.toContain('test-ebird-key');
  });

  it('exposes the current 18-region PSGC catalog and reads a published versioned snapshot', async () => {
    const { fetcher, calls } = createFetchMock(['amecro', 'amerob']);
    const speciesCodes = ['amecro', 'amerob'];
    const hash = checklistHash(speciesCodes);
    const app = appFor(fetcher, checklistStore({
      region_code: 'NIR',
      region_name: 'Negros Island Region',
      eligible_species_count: 2,
      checklist_version: `ebird-spplist:${hash}`,
      checklist_snapshot_date: '2026-11-12',
      checklist_hash: hash,
      species_codes: speciesCodes,
      source_region_codes: ['PH-NEC', 'PH-NER', 'PH-SIG'],
      snapshot_as_of: '2026-11-12T08:00:00.000Z',
    }));

    const regions = await request(app).get('/ebird/regions/philippines');
    expect(regions.status).toBe(200);
    expect(regions.body.count).toBe(18);
    expect(regions.body.regions.some((region: { code: string }) => region.code === 'NIR')).toBe(true);

    const checklist = await request(app).get('/ebird/checklists/NIR/spplist');
    expect(checklist.status).toBe(200);
    expect(checklist.body.eligibleSpeciesCount).toBe(2);
    expect(checklist.body.speciesCodes).toEqual(speciesCodes);
    expect(checklist.body.valueHash).toBe(hash);
    expect(checklist.body.version).toBe(`ebird-spplist:${hash}`);
    expect(calls).toHaveLength(0);
  });

  it('resolves a published region checklist to eBird species in checklist order', async () => {
    const speciesCodes = ['amecro', 'amerob'];
    const hash = checklistHash(speciesCodes);
    const { fetcher, calls } = createFetchMock([
      { speciesCode: 'amerob', comName: 'American Robin', sciName: 'Turdus migratorius', category: 'species' },
      { speciesCode: 'amecro', comName: 'American Crow', sciName: 'Corvus brachyrhynchos', category: 'species' },
    ]);
    const response = await request(appFor(fetcher, checklistStore({
      region_code: 'NIR',
      region_name: 'Negros Island Region',
      eligible_species_count: speciesCodes.length,
      checklist_version: `ebird-spplist:${hash}`,
      checklist_snapshot_date: '2026-11-12',
      checklist_hash: hash,
      species_codes: speciesCodes,
      source_region_codes: ['PH-NEC', 'PH-NER', 'PH-SIG'],
      snapshot_as_of: '2026-11-12T08:00:00.000Z',
    }))).get('/ebird/checklists/NIR/species');

    expect(response.status).toBe(200);
    expect(response.body.species.map((species: { speciesCode: string }) => species.speciesCode)).toEqual(speciesCodes);
    expect(response.body.species[0].comName).toBe('American Crow');
    expect(calls).toHaveLength(1);
  });

  it('resolves regional checklist forms and hybrids from the complete taxonomy', async () => {
    const speciesCodes = ['palcud1', 'x01041'];
    const hash = checklistHash(speciesCodes);
    const { fetcher, calls } = createFetchMock([
      { speciesCode: 'x01041', comName: 'Night Heron Hybrid', sciName: 'Nycticorax hybrid', category: 'hybrid' },
      { speciesCode: 'palcud1', comName: 'Palawan Cuckoo-Dove Form', sciName: 'Macropygia form', category: 'form' },
    ]);
    const response = await request(appFor(fetcher, checklistStore({
      region_code: 'NCR',
      region_name: 'National Capital Region',
      eligible_species_count: speciesCodes.length,
      checklist_version: `ebird-spplist:${hash}`,
      checklist_snapshot_date: '2026-11-13',
      checklist_hash: hash,
      species_codes: speciesCodes,
      source_region_codes: ['PH-NCR'],
      snapshot_as_of: '2026-11-13T08:00:00.000Z',
    }))).get('/ebird/checklists/NCR/species');

    expect(response.status).toBe(200);
    expect(response.body.species.map((species: { speciesCode: string }) => species.speciesCode)).toEqual(speciesCodes);
    expect(response.body.species.map((species: { category: string }) => species.category)).toEqual(['form', 'hybrid']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=en');
  });

  it('does not claim complete eBird denominators when a PSGC HUC lacks a verified eBird mapping', async () => {
    const response = await request(appFor()).get('/ebird/checklists/REGION_IX/spplist');
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('City of Isabela');
  });
});

import { describe, expect, it } from 'vitest';
import {
  philippineRegionalBoundaryEncodings,
  philippineRegionalBoundaryMetadata,
} from './data/philippineRegionalBoundaries.js';
import { findPhilippineRegion, philippineRegions } from './philippineRegions.js';
import {
  calculateRegionalProgress,
  collectQualifyingSpeciesForRegion,
  computeRegionalThresholds,
  pointInPhilippineRegion,
  type RegionalObservation,
} from './regionalRanks.js';
import {
  checklistHash,
  createRegionalChecklistProvider,
  RegionalChecklistSourceError,
  validateStoredChecklistSnapshot,
} from './regionalChecklists.js';

function observation(overrides: Partial<RegionalObservation> = {}): RegionalObservation {
  return {
    id: 'sighting-1',
    confidence: 0.9,
    ebirdSpecies: {
      speciesCode: 'testbird',
      comName: 'Test bird',
      sciName: 'Testus avis',
      category: 'species',
    },
    location: { latitude: 10.6765, longitude: 122.9509 },
    ...overrides,
  };
}

describe('Philippine regional rank qualification', () => {
  it('ships 18 valid region geometries and places Bacolod, Dumaguete, and Siquijor in NIR', () => {
    expect(Object.keys(philippineRegionalBoundaryEncodings)).toHaveLength(18);
    expect(philippineRegionalBoundaryMetadata.sourceFeatureCount).toBe(87);
    expect(philippineRegionalBoundaryMetadata.boundaryLicense).toBe('CC BY 3.0 IGO');
    const nir = findPhilippineRegion('NIR')!;
    expect(pointInPhilippineRegion({ latitude: 10.6765, longitude: 122.9509 }, nir)).toBe(true);
    expect(pointInPhilippineRegion({ latitude: 9.3068, longitude: 123.3054 }, nir)).toBe(true);
    expect(pointInPhilippineRegion({ latitude: 9.2142, longitude: 123.515 }, nir)).toBe(true);
    expect(pointInPhilippineRegion({ latitude: 14.5995, longitude: 120.9842 }, nir)).toBe(false);
  });

  it('counts only confident, GPS-tagged species in the chosen region and present in the active snapshot', () => {
    const region = findPhilippineRegion('NIR')!;
    const sightings = [
      observation(),
      observation({ id: 'duplicate', ebirdSpecies: { speciesCode: 'TESTBIRD', comName: 'Test bird', sciName: 'Testus avis', category: 'species' } }),
      observation({ id: 'wrong-region', location: { latitude: 14.5995, longitude: 120.9842 }, ebirdSpecies: { speciesCode: 'manila', comName: 'Other', sciName: 'Other avis', category: 'species' } }),
      observation({ id: 'missing-gps', location: null, ebirdSpecies: { speciesCode: 'nogps', comName: 'Other', sciName: 'Other avis', category: 'species' } }),
      observation({ id: 'low-confidence', confidence: 0.67, ebirdSpecies: { speciesCode: 'lowconf', comName: 'Other', sciName: 'Other avis', category: 'species' } }),
      observation({ id: 'non-species', ebirdSpecies: { speciesCode: 'group', comName: 'Bird group', sciName: 'Avis sp.', category: 'group' } }),
      observation({ id: 'unverified', ebirdSpecies: { speciesCode: 'not-in-snapshot', comName: 'Unverified', sciName: 'Unverified avis', category: 'species' } }),
    ];

    const result = collectQualifyingSpeciesForRegion({
      observations: sightings,
      region,
      speciesCodes: ['testbird'],
    });
    expect(result.status).toBe('ready');
    expect(result.speciesCodes).toEqual(['testbird']);
    expect(result.count).toBe(1);
  });

  it('uses exactly one species for Hatchling and ceil percentage gates without forcing gates past small lists', () => {
    expect(computeRegionalThresholds(0)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(computeRegionalThresholds(1)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(computeRegionalThresholds(2)).toEqual([1, 1, 1, 1, 2, 2]);
    expect(computeRegionalThresholds(3)).toEqual([1, 1, 1, 2, 3, 3]);
    expect(computeRegionalThresholds(100)).toEqual([1, 10, 25, 50, 75, 100]);
    const unlocked = calculateRegionalProgress(100, 1);
    expect(unlocked.currentRank?.id).toBe('hatchling');
    expect(unlocked.nextRank?.id).toBe('feather-scout');
  });
});

describe('versioned regional checklist snapshots', () => {
  it('derives NIR from verified eBird province lists and stores sorted, deduplicated codes with a content hash', async () => {
    const calls: string[] = [];
    const referenceRows = [
      { code: 'PH-NEC', name: 'Negros Occidental' },
      { code: 'PH-NER', name: 'Negros Oriental' },
      { code: 'PH-SIG', name: 'Siquijor' },
    ];
    const lists: Record<string, string[]> = {
      'PH-NEC': ['zebrasp', 'amerob'],
      'PH-NER': ['amerob', 'birdtwo'],
      'PH-SIG': ['birdone'],
    };
    const provider = createRegionalChecklistProvider({
      apiKey: 'server-only-token',
      now: () => new Date('2026-11-12T09:00:00.000Z'),
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith('/subnational1/PH')) return new Response(JSON.stringify(referenceRows));
        return new Response(JSON.stringify(lists[url.pathname.split('/').pop()!] ?? []));
      },
    });

    const snapshot = await provider.refresh('NIR');
    expect(snapshot.speciesCodes).toEqual(['amerob', 'birdone', 'birdtwo', 'zebrasp']);
    expect(snapshot.eligibleSpeciesCount).toBe(snapshot.speciesCodes.length);
    expect(snapshot.sourceRegionCodes).toEqual(['PH-NEC', 'PH-NER', 'PH-SIG']);
    expect(snapshot.valueHash).toBe(checklistHash(snapshot.speciesCodes));
    expect(snapshot.version).toBe(`ebird-spplist:${snapshot.valueHash}`);
    expect(snapshot.asOf).toBe('2026-11-12T09:00:00.000Z');
    expect(calls).toHaveLength(4);
    expect(calls).not.toContain('/product/spplist/NIR');
  });

  it('rejects regions with PSGC city units absent from the live eBird region list', async () => {
    const provider = createRegionalChecklistProvider({ apiKey: 'server-only-token' });
    await expect(provider.refresh('REGION_IX')).rejects.toMatchObject<Partial<RegionalChecklistSourceError>>({
      status: 409,
      message: expect.stringContaining('City of Isabela'),
    });
    await expect(provider.refresh('BARMM')).rejects.toMatchObject<Partial<RegionalChecklistSourceError>>({
      status: 409,
      message: expect.stringContaining('Cotabato City'),
    });
  });

  it('validates persisted snapshot species contents against count, sorting, hash, and version', () => {
    const speciesCodes = ['amerob', 'birdtwo'];
    const hash = checklistHash(speciesCodes);
    const row = {
      region_code: 'NIR',
      region_name: 'Negros Island Region',
      eligible_species_count: 2,
      checklist_version: `ebird-spplist:${hash}`,
      checklist_snapshot_date: '2026-11-12',
      checklist_hash: hash,
      species_codes: speciesCodes,
      source_region_codes: ['PH-NEC', 'PH-NER', 'PH-SIG'],
      snapshot_as_of: '2026-11-12T09:00:00.000Z',
    };
    expect(validateStoredChecklistSnapshot(row)?.speciesCodes).toEqual(speciesCodes);
    expect(validateStoredChecklistSnapshot({ ...row, eligible_species_count: 3 })).toBeNull();
    expect(validateStoredChecklistSnapshot({ ...row, species_codes: ['birdtwo', 'amerob'] })).toBeNull();
    expect(validateStoredChecklistSnapshot({ ...row, checklist_hash: '0'.repeat(64) })).toBeNull();
  });

  it('keeps canonical region assignment metadata for all 18 regions', () => {
    expect(philippineRegions).toHaveLength(18);
    expect(new Set(philippineRegions.map((region) => region.psgc)).size).toBe(18);
  });
});

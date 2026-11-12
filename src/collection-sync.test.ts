import { describe, expect, it, vi } from 'vitest';
import type { BirdObservation } from '../../src/services/collection.js';
import { mergeObservations, mergeSavedBirdIds } from '../../src/services/collectionSyncData.js';
import { syncCollectionSnapshot, type CollectionSyncAdapter } from '../../src/services/collectionSyncEngine.js';
import { getCollectionStorageKeys } from '../../src/services/collectionKeys.js';

const localObservation: BirdObservation = {
  id: 'device-1',
  commonName: 'Northern Flicker',
  scientificName: 'Colaptes auratus',
  description: 'A local note.',
  confidence: 0.9,
  regions: ['North America'],
  identifiedAt: '2026-11-01T10:00:00.000Z',
  photoUri: 'file:///local/flicker.jpg',
  location: { latitude: 45.5, longitude: -122.6 },
};

describe('collection sync merge behavior', () => {
  it('uses isolated on-device storage keys for each signed-in account', () => {
    const firstUserKeys = getCollectionStorageKeys('account-one');
    const secondUserKeys = getCollectionStorageKeys('account-two');
    expect(firstUserKeys.savedBirds).not.toBe(secondUserKeys.savedBirds);
    expect(firstUserKeys.observations).not.toBe(secondUserKeys.observations);
    expect(getCollectionStorageKeys(null).observations).toBe('wingdex.observations.v1');
  });

  it('unions local and remote saved birds without restoring explicit local removals', () => {
    expect(mergeSavedBirdIds(['local', 'removed'], ['remote', 'removed'], ['removed']))
      .toEqual(['local', 'remote']);
  });

  it('merges remote observations and preserves local photo references for matching identities', () => {
    const result = mergeObservations(
      [localObservation],
      [
        {
          client_id: 'device-1',
          common_name: 'Northern Flicker',
          scientific_name: 'Colaptes auratus',
          description: 'Remote version.',
          confidence: 0.8,
          regions: ['North America'],
          identified_at: '2026-11-01T10:00:00.000Z',
          latitude: 45.5,
          longitude: -122.6,
          ebird_species: null,
        },
        {
          client_id: 'other-device-2',
          common_name: 'Varied Thrush',
          scientific_name: 'Ixoreus naevius',
          description: null,
          confidence: 0.85,
          regions: ['North America'],
          identified_at: '2026-11-02T10:00:00.000Z',
          latitude: null,
          longitude: null,
          ebird_species: {
            speciesCode: 'varthr',
            comName: 'Varied Thrush',
            sciName: 'Ixoreus naevius',
            category: 'species',
          },
        },
      ],
    );

    expect(result).toHaveLength(2);
    expect(result.find((observation) => observation.id === 'device-1')?.photoUri)
      .toBe('file:///local/flicker.jpg');
    expect(result[0].id).toBe('other-device-2');
    expect(result[0].location).toBeNull();
    expect(result[0].ebirdSpecies?.speciesCode).toBe('varthr');
  });

  it('scopes every sync operation to the signed-in user and removes only explicit tombstones', async () => {
    const adapter: CollectionSyncAdapter = {
      removeSavedBirds: vi.fn(async () => undefined),
      upsertSavedBirds: vi.fn(async () => undefined),
      upsertObservations: vi.fn(async () => undefined),
      loadSavedBirdIds: vi.fn(async () => ['remote']),
      loadObservations: vi.fn(async () => []),
      saveLocalSnapshot: vi.fn(async () => undefined),
      clearRemovedSavedBirdIds: vi.fn(async () => undefined),
    };

    await syncCollectionSnapshot('signed-in-user', ['local', 'removed'], [localObservation], ['removed'], adapter);

    expect(adapter.removeSavedBirds).toHaveBeenCalledWith('signed-in-user', ['removed']);
    expect(adapter.upsertSavedBirds).toHaveBeenCalledWith('signed-in-user', ['local']);
    expect(adapter.upsertObservations).toHaveBeenCalledWith('signed-in-user', [localObservation]);
    expect(adapter.saveLocalSnapshot).toHaveBeenCalledWith('signed-in-user', ['local', 'remote'], [localObservation]);
    expect(adapter.clearRemovedSavedBirdIds).toHaveBeenCalledWith('signed-in-user', ['removed']);
  });

  it('keeps local snapshots and removal tombstones intact when a remote read fails', async () => {
    const adapter: CollectionSyncAdapter = {
      removeSavedBirds: vi.fn(async () => undefined),
      upsertSavedBirds: vi.fn(async () => undefined),
      upsertObservations: vi.fn(async () => undefined),
      loadSavedBirdIds: vi.fn(async () => []),
      loadObservations: vi.fn(async () => { throw new Error('network unavailable'); }),
      saveLocalSnapshot: vi.fn(async () => undefined),
      clearRemovedSavedBirdIds: vi.fn(async () => undefined),
    };

    await expect(syncCollectionSnapshot('signed-in-user', ['local'], [localObservation], [], adapter))
      .rejects.toThrow('network unavailable');

    expect(adapter.removeSavedBirds).not.toHaveBeenCalled();
    expect(adapter.saveLocalSnapshot).not.toHaveBeenCalled();
    expect(adapter.clearRemovedSavedBirdIds).not.toHaveBeenCalled();
  });
});

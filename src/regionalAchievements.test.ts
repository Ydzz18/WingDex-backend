import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from './app.js';
import { checklistHash } from './regionalChecklists.js';

const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const checklistCodes = ['amerob', ...Array.from({ length: 10 }, (_, index) => `spc${String(index).padStart(3, '0')}`)].sort();
const hash = checklistHash(checklistCodes);

function createSupabaseMock(homeRegion = 'NIR') {
  const rows: Record<string, Record<string, unknown>[]> = {
    profiles: [{ id: userId, home_region_code: homeRegion }],
    regional_rank_checklists: [{
      region_code: 'NIR',
      region_name: 'Negros Island Region',
      eligible_species_count: checklistCodes.length,
      checklist_version: `ebird-spplist:${hash}`,
      checklist_snapshot_date: '2026-11-12',
      checklist_hash: hash,
      species_codes: checklistCodes,
      source_region_codes: ['PH-NEC', 'PH-NER', 'PH-SIG'],
      snapshot_as_of: '2026-11-12T09:00:00.000Z',
      is_published: true,
    }],
    observations: [{
      user_id: userId,
      client_id: 'observation-1',
      common_name: 'Test bird',
      scientific_name: 'Testus avis',
      description: null,
      confidence: 0.9,
      regions: ['Asia'],
      identified_at: '2026-11-12T08:00:00.000Z',
      latitude: 10.6765,
      longitude: 122.9509,
      ebird_species: { speciesCode: 'amerob', comName: 'Test bird', sciName: 'Testus avis', category: 'species' },
    }],
    regional_rank_achievements: [],
  };
  const client = {
    auth: {
      getUser: vi.fn(async (token: string) => ({
        data: { user: token === 'user-token' ? { id: userId } : null },
        error: token === 'user-token' ? null : new Error('invalid token'),
      })),
    },
    from(table: string) {
      let filters: Record<string, unknown> = {};
      let operation = 'select';
      let values: Record<string, unknown>[] = [];
      let offset = 0;
      let end = Number.POSITIVE_INFINITY;
      const builder = {
        select() { operation = 'select'; return builder; },
        eq(column: string, value: unknown) { filters[column] = value; return builder; },
        range(start: number, last: number) { offset = start; end = last; return builder; },
        order() { return builder; },
        upsert(payload: Record<string, unknown>[]) { operation = 'upsert'; values = payload; return builder; },
        matches() {
          return (rows[table] ?? []).filter((row) =>
            Object.entries(filters).every(([key, value]) => row[key] === value));
        },
        maybeSingle() {
          return Promise.resolve({ data: builder.matches()[0] ?? null, error: null });
        },
        then(resolve: (result: { data: unknown; error: null }) => unknown) {
          if (operation === 'upsert') {
            for (const value of values) {
              const found = (rows[table] ?? []).some((row) =>
                row.user_id === value.user_id && row.region_code === value.region_code && row.rank_code === value.rank_code);
              if (!found) (rows[table] ??= []).push({ ...value });
            }
          }
          return Promise.resolve(resolve({
            data: builder.matches().slice(offset, end + 1),
            error: null,
          }));
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, rows, auth: client.auth };
}

function appFor(homeRegion?: string) {
  const mock = createSupabaseMock(homeRegion);
  return {
    ...mock,
    app: createApp({
      identifyPhoto: vi.fn(),
      regionalAchievements: { getSupabase: () => mock.client },
    }),
  };
}

describe('authenticated regional rank achievements', () => {
  it('verifies the user home region, counts server-synced GPS observations, and preserves earned rank history', async () => {
    const { app, rows } = appFor();
    const response = await request(app)
      .post('/regional-ranks/achievements')
      .set('Authorization', 'Bearer user-token')
      .send({ regionCode: 'NIR' })
      .expect(200);
    expect(response.body.qualifyingSpeciesCount).toBe(1);
    expect(response.body.currentRankCode).toBe('hatchling');
    expect(response.body.achievements).toHaveLength(1);
    expect(rows.regional_rank_achievements[0].checklist_version).toBe(`ebird-spplist:${hash}`);
  });

  it('rejects missing and invalid sessions and prevents syncing a non-home region', async () => {
    const { app, auth } = appFor('NCR');
    await request(app)
      .post('/regional-ranks/achievements')
      .send({ regionCode: 'NIR' })
      .expect(401);
    await request(app)
      .post('/regional-ranks/achievements')
      .set('Authorization', 'Bearer invalid-token')
      .send({ regionCode: 'NIR' })
      .expect(401);
    const mismatch = await request(app)
      .post('/regional-ranks/achievements')
      .set('Authorization', 'Bearer user-token')
      .send({ regionCode: 'NIR' })
      .expect(409);
    expect(mismatch.body.error).toContain('home region');
    expect(auth.getUser).toHaveBeenCalledTimes(2);
  });
});

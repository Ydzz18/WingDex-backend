import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from './app.js';

const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createSupabaseMock() {
  const rows = new Map<string, Record<string, unknown>[]>([
    ['badges', []],
    ['ranks', []],
    ['announcements', []],
  ]);
  const supabase = {
    auth: {
      getUser: vi.fn(async (token: string) => ({
        data: {
          user: token === 'admin-token'
            ? { id: adminId, app_metadata: { role: 'member' } }
            : token === 'other-token'
              ? { id: otherId, app_metadata: { role: 'admin' } }
              : null,
        },
        error: token === 'admin-token' || token === 'other-token' ? null : new Error('invalid token'),
      })),
    },
    from(table: string) {
      let operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let value: Record<string, unknown> = {};
      let identifier = '';
      let single = false;
      const builder = {
        select() { return builder; },
        order() { return builder; },
        range() { return builder; },
        ilike() { return builder; },
        insert(payload: Record<string, unknown>) { operation = 'insert'; value = payload; return builder; },
        update(payload: Record<string, unknown>) { operation = 'update'; value = payload; return builder; },
        delete() { operation = 'delete'; return builder; },
        eq(_column: string, id: string) { identifier = id; return builder; },
        single() { single = true; return builder; },
        then(resolve: (result: { data: unknown; error: null; count: number }) => unknown) {
          const tableRows = rows.get(table) ?? [];
          let data: unknown = tableRows;
          if (operation === 'insert') {
            const inserted = { id: crypto.randomUUID(), ...value, updated_at: new Date().toISOString() };
            tableRows.push(inserted);
            data = inserted;
          } else if (operation === 'update') {
            const row = tableRows.find((candidate) => candidate.id === identifier);
            if (row) Object.assign(row, value);
            data = row ?? null;
          } else if (operation === 'delete') {
            const index = tableRows.findIndex((candidate) => candidate.id === identifier);
            data = index < 0 ? null : { id: tableRows[index].id };
            if (index >= 0) tableRows.splice(index, 1);
          }
          if (!rows.has(table)) rows.set(table, tableRows);
          return Promise.resolve(resolve({
            data: single && Array.isArray(data) ? data[0] ?? null : data,
            error: null,
            count: tableRows.length,
          }));
        },
      };
      return builder;
    },
    rpc: vi.fn(async () => ({ data: { total: 0, rows: [] }, error: null })),
  };
  return { client: supabase as unknown as SupabaseClient, rows, supabase };
}

function appFor(adminUserIds = adminId) {
  const mock = createSupabaseMock();
  return {
    ...mock,
    app: createApp({
      identifyPhoto: vi.fn(),
      admin: { adminUserIds, getSupabase: () => mock.client },
    }),
  };
}

describe('admin access', () => {
  it('rejects unauthenticated admin API requests', async () => {
    const { app } = appFor();
    const response = await request(app).get('/admin/overview');
    expect(response.status).toBe(401);
  });

  it('rejects valid users who are not on the server allowlist regardless of metadata', async () => {
    const { app } = appFor();
    const response = await request(app)
      .get('/admin/overview')
      .set('Authorization', 'Bearer other-token');
    expect(response.status).toBe(403);
  });

  it('allows a verified allowlisted user and does not rely on client role metadata', async () => {
    const { app, supabase } = appFor();
    const response = await request(app)
      .get('/admin/overview')
      .set('Authorization', 'Bearer admin-token');
    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('admin_dashboard_overview');
  });

  it('disables the admin API if the server allowlist is missing or invalid', async () => {
    const { app } = appFor('not-a-user-id');
    const response = await request(app)
      .get('/admin/overview')
      .set('Authorization', 'Bearer admin-token');
    expect(response.status).toBe(503);
  });

  it('validates and protects content create, update, and delete operations', async () => {
    const { app, rows } = appFor();
    const auth = { Authorization: 'Bearer admin-token' };
    const invalid = await request(app)
      .post('/admin/badges')
      .set(auth)
      .send({ title: '', rule_type: 'arbitrary', threshold: -1 });
    expect(invalid.status).toBe(400);

    const created = await request(app)
      .post('/admin/badges')
      .set(auth)
      .send({
        title: 'Field observer',
        description: 'Log five observations.',
        rule_type: 'observations',
        threshold: 5,
        is_active: true,
      });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('Field observer');
    const badgeId = created.body.id;

    const updated = await request(app)
      .patch(`/admin/badges/${badgeId}`)
      .set(auth)
      .send({ is_active: false });
    expect(updated.status).toBe(200);
    expect(updated.body.is_active).toBe(false);

    const deleted = await request(app)
      .delete(`/admin/badges/${badgeId}`)
      .set(auth);
    expect(deleted.status).toBe(200);
    expect(rows.get('badges')).toHaveLength(0);

    const rank = await request(app)
      .post('/admin/ranks')
      .set(auth)
      .send({ title: 'Field naturalist', threshold: 25, is_published: true });
    expect(rank.status).toBe(201);
    const unpublishedRank = await request(app)
      .patch(`/admin/ranks/${rank.body.id}`)
      .set(auth)
      .send({ is_published: false });
    expect(unpublishedRank.body.is_published).toBe(false);
    await request(app).delete(`/admin/ranks/${rank.body.id}`).set(auth).expect(200);

    const announcement = await request(app)
      .post('/admin/announcements')
      .set(auth)
      .send({ title: 'A new season', body: 'Welcome back to the trail.', status: 'draft', audience: 'all' });
    expect(announcement.status).toBe(201);
    const publishedAnnouncement = await request(app)
      .patch(`/admin/announcements/${announcement.body.id}`)
      .set(auth)
      .send({ status: 'published' });
    expect(publishedAnnouncement.body.status).toBe('published');
    const archivedAnnouncement = await request(app)
      .patch(`/admin/announcements/${announcement.body.id}`)
      .set(auth)
      .send({ status: 'archived' });
    expect(archivedAnnouncement.body.status).toBe('archived');
    expect(rows.get('announcements')).toHaveLength(1);
  });
});

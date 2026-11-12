import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const originalUrl = process.env.SUPABASE_URL;
const originalSecretKey = process.env.SUPABASE_SECRET_KEY;

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}));

afterEach(() => {
  if (originalUrl === undefined) {
    delete process.env.SUPABASE_URL;
  } else {
    process.env.SUPABASE_URL = originalUrl;
  }

  if (originalSecretKey === undefined) {
    delete process.env.SUPABASE_SECRET_KEY;
  } else {
    process.env.SUPABASE_SECRET_KEY = originalSecretKey;
  }

  vi.clearAllMocks();
});

describe('Supabase client configuration', () => {
  it('requires server credentials and reuses the configured client', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const { getSupabaseClient } = await import('./supabase.js');

    expect(() => getSupabaseClient()).toThrow(
      'SUPABASE_URL and SUPABASE_SECRET_KEY are required to connect to Supabase.'
    );

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
    const client = getSupabaseClient();

    expect(getSupabaseClient()).toBe(client);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'test-secret-key',
      {
        auth: { autoRefreshToken: false, persistSession: false },
        realtime: { transport: expect.any(Function) },
      }
    );
  });
});

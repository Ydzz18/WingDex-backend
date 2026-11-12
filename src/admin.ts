import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabaseClient } from './supabase.js';

type AdminOptions = {
  getSupabase?: () => SupabaseClient;
  adminUserIds?: string;
};

const badgeInput = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  rule_type: z.enum(['unique_species', 'observations', 'saved_species']),
  threshold: z.number().int().min(1).max(1_000_000),
  is_active: z.boolean(),
}).strict();

const rankInput = z.object({
  title: z.string().trim().min(1).max(80),
  threshold: z.number().int().min(1).max(1_000_000),
  is_published: z.boolean(),
}).strict();

const announcementInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  status: z.enum(['draft', 'published', 'archived']),
  audience: z.literal('all').default('all'),
}).strict();

const updateSchemas = {
  badges: badgeInput.partial(),
  ranks: rankInput.partial(),
  announcements: announcementInput.partial(),
} as const;

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(100).default(''),
});

function parseAllowlist(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)),
  );
}

function getBearerToken(header: string | undefined) {
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

function sendDatabaseError(response: Response, error?: unknown) {
  if (isRecord(error) && 'code' in error && error.code === '23505') {
    response.status(409).json({ error: 'That value is already in use.' });
    return;
  }
  if (isRecord(error) && 'code' in error && error.code === 'PGRST116') {
    response.status(404).json({ error: 'Admin content was not found.' });
    return;
  }
  response.status(500).json({ error: 'The admin request could not be completed.' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleDatabaseRequest<T>(
  response: Response,
  run: () => PromiseLike<{ data: T | null; error: unknown; count?: number | null }>,
  successStatus = 200,
) {
  try {
    const result = await run();
    if (result.error) {
      sendDatabaseError(response, result.error);
      return;
    }
    response.status(successStatus).json(result.data);
  } catch {
    sendDatabaseError(response);
  }
}

export function createAdminRouter(options: AdminOptions = {}) {
  const router = Router();
  const getClient = options.getSupabase ?? getSupabaseClient;
  const allowlistedUserIds = parseAllowlist(options.adminUserIds ?? process.env.ADMIN_USER_IDS);

  router.use(async (request: Request, response: Response, next) => {
    if (allowlistedUserIds.size === 0) {
      response.status(503).json({ error: 'Admin access is disabled. Configure ADMIN_USER_IDS on the backend.' });
      return;
    }

    const accessToken = getBearerToken(request.header('authorization'));
    if (!accessToken) {
      response.status(401).json({ error: 'Sign in to continue.' });
      return;
    }

    try {
      const supabase = getClient();
      const { data, error } = await supabase.auth.getUser(accessToken);
      const userId = data.user?.id?.toLowerCase();
      if (error || !userId) {
        response.status(401).json({ error: 'Your admin session is invalid or expired.' });
        return;
      }
      if (!allowlistedUserIds.has(userId)) {
        response.status(403).json({ error: 'This account is not authorized to use the admin portal.' });
        return;
      }
      response.locals.adminSupabase = supabase;
      next();
    } catch {
      response.status(503).json({ error: 'Admin verification is unavailable. Check backend Supabase configuration.' });
    }
  });

  router.get('/overview', (request, response) => {
    const supabase = response.locals.adminSupabase as SupabaseClient;
    void handleDatabaseRequest(response, () => supabase.rpc('admin_dashboard_overview'));
  });

  router.get('/users', (request, response) => {
    const parsed = pageQuery.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: 'Use a page from 1–100000, page size from 1–50, and search text up to 100 characters.' });
      return;
    }
    const { page, pageSize, search } = parsed.data;
    const supabase = response.locals.adminSupabase as SupabaseClient;
    void handleDatabaseRequest(response, () =>
      supabase.rpc('admin_search_users', {
        search_text: search,
        page_size: pageSize,
        page_offset: (page - 1) * pageSize,
      }),
    );
  });

  router.get('/collections', (request, response) => {
    const parsed = pageQuery.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: 'Use a page from 1–100000, page size from 1–50, and search text up to 100 characters.' });
      return;
    }
    const { page, pageSize, search } = parsed.data;
    const supabase = response.locals.adminSupabase as SupabaseClient;
    void handleDatabaseRequest(response, () =>
      supabase.rpc('admin_search_collections', {
        search_text: search,
        page_size: pageSize,
        page_offset: (page - 1) * pageSize,
      }),
    );
  });

  const contentTables = ['badges', 'ranks', 'announcements'] as const;
  for (const table of contentTables) {
    router.get(`/${table}`, (request, response) => {
      const parsed = pageQuery.safeParse(request.query);
      if (!parsed.success) {
        response.status(400).json({ error: 'Invalid pagination or search query.' });
        return;
      }
      const { page, pageSize, search } = parsed.data;
      const supabase = response.locals.adminSupabase as SupabaseClient;
      let query = supabase.from(table).select('*', { count: 'exact' });
      if (search) query = query.ilike('title', `%${search}%`);
      void (async () => {
        try {
          const result = await query
            .order('updated_at', { ascending: false })
            .range((page - 1) * pageSize, page * pageSize - 1);
          if (result.error) {
            sendDatabaseError(response, result.error);
            return;
          }
          response.json({ rows: result.data ?? [], total: result.count ?? 0 });
        } catch {
          sendDatabaseError(response);
        }
      })();
    });

    router.post(`/${table}`, (request, response) => {
      const parsed = (table === 'badges' ? badgeInput : table === 'ranks' ? rankInput : announcementInput)
        .safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'Check the content fields and try again.', details: parsed.error.flatten().fieldErrors });
        return;
      }
      const supabase = response.locals.adminSupabase as SupabaseClient;
      void handleDatabaseRequest(
        response,
        () => supabase.from(table).insert(parsed.data as never).select('*').single(),
        201,
      );
    });

    router.patch(`/${table}/:id`, (request, response) => {
      const parsedId = z.string().uuid().safeParse(request.params.id);
      const parsedBody = updateSchemas[table].safeParse(request.body);
      if (!parsedId.success || !parsedBody.success || Object.keys(parsedBody.data).length === 0) {
        response.status(400).json({ error: 'Check the content identifier and updated fields.' });
        return;
      }
      const supabase = response.locals.adminSupabase as SupabaseClient;
      void handleDatabaseRequest(response, () =>
        supabase.from(table).update(parsedBody.data).eq('id', parsedId.data).select('*').single(),
      );
    });

    router.delete(`/${table}/:id`, (request, response) => {
      const parsedId = z.string().uuid().safeParse(request.params.id);
      if (!parsedId.success) {
        response.status(400).json({ error: 'Invalid content identifier.' });
        return;
      }
      const supabase = response.locals.adminSupabase as SupabaseClient;
      void handleDatabaseRequest(response, () =>
        supabase.from(table).delete().eq('id', parsedId.data).select('id').single(),
      );
    });
  }

  router.use((error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => {
    if (isRecord(error) && 'status' in error && error.status === 413) {
      response.status(413).json({ error: 'Request body is too large.' });
      return;
    }
    sendDatabaseError(response);
  });

  return router;
}

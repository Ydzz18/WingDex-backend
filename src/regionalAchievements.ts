import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { findPhilippineRegion } from './philippineRegions.js';
import { calculateRegionalProgress, collectQualifyingSpeciesForRegion } from './regionalRanks.js';
import {
  regionalRankDefinitions,
  RegionalChecklistSourceError,
  validateStoredChecklistSnapshot,
} from './regionalChecklists.js';
import { getSupabaseClient } from './supabase.js';

function getBearerToken(header: string | undefined) {
  return header?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendError(response: Response, status: number, message: string) {
  response.status(status).json({ error: message });
}

export function createRegionalAchievementsRouter(options: {
  getSupabase?: () => SupabaseClient;
} = {}) {
  const router = Router();
  const getClient = options.getSupabase ?? getSupabaseClient;

  router.post('/achievements', async (request: Request, response: Response) => {
    const parsedBody = z.object({ regionCode: z.string().regex(/^[A-Z_]{2,12}$/i) }).safeParse(request.body);
    if (!parsedBody.success) {
      sendError(response, 400, 'A valid Philippine PSGC home region is required.');
      return;
    }
    const region = findPhilippineRegion(parsedBody.data.regionCode);
    if (!region) {
      sendError(response, 400, 'Choose one of the current 18 Philippine home regions.');
      return;
    }
    const accessToken = getBearerToken(request.header('authorization'));
    if (!accessToken) {
      sendError(response, 401, 'Sign in to sync regional rank achievements.');
      return;
    }

    try {
      const supabase = getClient();
      const { data: userData, error: authError } = await supabase.auth.getUser(accessToken);
      const userId = userData.user?.id;
      if (authError || !userId) {
        sendError(response, 401, 'Your Wingdex session is invalid or expired.');
        return;
      }

      const profile = await supabase.from('profiles').select('home_region_code').eq('id', userId).maybeSingle();
      if (profile.error) {
        sendError(response, 503, 'Your saved home region could not be verified.');
        return;
      }
      if (profile.data?.home_region_code !== region.code) {
        sendError(response, 409, 'Choose and save this home region on your profile before syncing its ranks.');
        return;
      }

      const checklistResult = await supabase
        .from('regional_rank_checklists')
        .select('*')
        .eq('region_code', region.code)
        .eq('is_published', true)
        .maybeSingle();
      if (checklistResult.error) {
        sendError(response, 503, 'The active regional checklist could not be loaded.');
        return;
      }
      if (!checklistResult.data) {
        sendError(response, 404, `No published all-time checklist is available for ${region.name}.`);
        return;
      }
      const checklist = validateStoredChecklistSnapshot(checklistResult.data as Record<string, unknown>);
      if (!checklist) {
        sendError(response, 503, 'The published checklist contents failed validation.');
        return;
      }

      const observations: Parameters<typeof collectQualifyingSpeciesForRegion>[0]['observations'] = [];
      const batchSize = 500;
      for (let offset = 0; ; offset += batchSize) {
        const result = await supabase
          .from('observations')
          .select('client_id,common_name,scientific_name,description,confidence,regions,identified_at,latitude,longitude,ebird_species')
          .eq('user_id', userId)
          .range(offset, offset + batchSize - 1);
        if (result.error || !Array.isArray(result.data)) {
          sendError(response, 503, 'Your synced field observations could not be checked.');
          return;
        }
        for (const raw of result.data) {
          if (!isRecord(raw)) continue;
          const species = raw.ebird_species;
          const latitude = raw.latitude;
          const longitude = raw.longitude;
          const location = typeof latitude === 'number' && Number.isFinite(latitude)
            && typeof longitude === 'number' && Number.isFinite(longitude)
            ? { latitude, longitude }
            : null;
          observations.push({
            confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
            location,
            ...(isRecord(species) ? { ebirdSpecies: species as never } : {}),
          });
        }
        if (result.data.length < batchSize) break;
      }

      const qualifying = collectQualifyingSpeciesForRegion({
        observations,
        region,
        speciesCodes: checklist.speciesCodes,
      });
      const progress = calculateRegionalProgress(checklist.eligibleSpeciesCount, qualifying.count);
      const earnedThrough = progress.currentRank
        ? regionalRankDefinitions.findIndex((rank) => rank.rank_code === progress.currentRank?.id) + 1
        : 0;
      const earnedAt = checklist.asOf;
      if (earnedThrough > 0) {
        const rows = regionalRankDefinitions.slice(0, earnedThrough).map((rank) => ({
          user_id: userId,
          region_code: region.code,
          rank_code: rank.rank_code,
          checklist_version: checklist.version,
          unlocked_at: earnedAt,
        }));
        const insert = await supabase.from('regional_rank_achievements').upsert(rows, {
          onConflict: 'user_id,region_code,rank_code',
          ignoreDuplicates: true,
        });
        if (insert.error) {
          sendError(response, 503, 'Your earned regional ranks could not be saved.');
          return;
        }
      }

      const stored = await supabase
        .from('regional_rank_achievements')
        .select('rank_code,checklist_version,unlocked_at')
        .eq('user_id', userId)
        .eq('region_code', region.code)
        .order('unlocked_at', { ascending: true });
      if (stored.error || !Array.isArray(stored.data)) {
        sendError(response, 503, 'Your saved rank achievements could not be loaded.');
        return;
      }
      response.json({
        regionCode: region.code,
        checklistVersion: checklist.version,
        qualifyingSpeciesCount: qualifying.count,
        currentRankCode: progress.currentRank?.id ?? null,
        achievements: stored.data,
      });
    } catch (error) {
      if (error instanceof RegionalChecklistSourceError) {
        sendError(response, error.status, error.message);
        return;
      }
      sendError(response, 503, 'Regional ranks could not be synchronized.');
    }
  });

  return router;
}

// @ts-nocheck
// Edge Function to automatically populate game results from ESPN
// Deploy with: supabase functions deploy populate-game-results
// Schedule with cron or call via webhook after games finish

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request): Promise<Response> => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_URL') : '') ?? '',
      (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') : '') ?? ''
    )

    // Get week from query param or auto-detect
    const url = new URL(req.url)
    let week = parseInt(url.searchParams.get('week') || '0')
    const season = parseInt(url.searchParams.get('season') || '2025')
    
    if (week === 0) {
      // Auto-detect current week
      const now = new Date()
      const seasonStart2025 = new Date('2025-09-04T00:00:00Z')
      const diffTime = now.getTime() - seasonStart2025.getTime()
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
      week = now >= seasonStart2025 ? Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1)) : 1
    }

    console.log(`[GameResults] Fetching final scores for week ${week}, season ${season}...`)
    
    // Fetch games from ESPN
    const espnRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}`,
      { 
        headers: { 'Accept': 'application/json' },
      }
    )
    
    if (!espnRes.ok) {
      throw new Error(`ESPN API error: ${espnRes.status}`)
    }
    
    const espnData = await espnRes.json()
    
    if (!espnData || !espnData.events) {
      throw new Error('Invalid data from ESPN API')
    }
    
    let inserted = 0
    let updated = 0
    const errors = []
    const processed = []
    
    for (const event of espnData.events) {
      try {
        const comp = event.competitions[0]
        const away = comp.competitors.find((c: any) => c.homeAway === "away") || comp.competitors[0]
        const home = comp.competitors.find((c: any) => c.homeAway === "home") || comp.competitors[1]
        
        // Only process completed games
        const status = comp.status?.type?.name
        if (status !== 'STATUS_FINAL' && status !== 'STATUS_FULL_TIME') {
          console.log(`[GameResults] Skipping game ${event.id}: not final (${status})`)
          continue
        }
        
        const homeScore = parseInt(home.score || '0')
        const awayScore = parseInt(away.score || '0')
        const winner = homeScore > awayScore 
          ? (home.team.abbreviation || home.team.displayName)
          : awayScore > homeScore 
            ? (away.team.abbreviation || away.team.displayName)
            : 'TIE'
        
        // Upsert into game_results
        const gameResult = {
          game_id: event.id,
          week,
          season,
          home_team: home.team.abbreviation || home.team.displayName,
          away_team: away.team.abbreviation || away.team.displayName,
          home_score: homeScore,
          away_score: awayScore,
          winner,
          // Lines & outcomes are league-specific; left null here
          spread_result: null,
          spread_line: null,
          total_result: null,
          total_line: null,
          is_final: true,
        }
        
        const { error } = await supabaseClient
          .from('game_results')
          .upsert(gameResult, { onConflict: 'game_id' })
        
        if (error) {
          console.error(`[GameResults] Error upserting game ${event.id}:`, error)
          errors.push({ gameId: event.id, error: error.message })
        } else {
          console.log(`[GameResults] ✓ Saved game ${event.id}: ${away.team.abbreviation} ${awayScore} @ ${home.team.abbreviation} ${homeScore}`)
          inserted++
          processed.push({
            gameId: event.id,
            away: away.team.abbreviation,
            home: home.team.abbreviation,
            score: `${awayScore}-${homeScore}`
          })
        }
      } catch (gameErr: unknown) {
        const msg = gameErr instanceof Error ? gameErr.message : String(gameErr)
        console.error(`[GameResults] Error processing game ${event.id}:`, msg)
        errors.push({ gameId: event.id, error: msg })
      }
    }
    
    console.log(`[GameResults] Complete: ${inserted} games saved, ${errors.length} errors`)
    
    return new Response(
      JSON.stringify({
        success: true,
        week,
        season,
        inserted,
        updated,
        errors: errors.length,
        processed,
        errorDetails: errors.length > 0 ? errors : undefined
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    )
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[GameResults] Fatal error:', msg)
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    )
  }
})

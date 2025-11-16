-- Migration: Add master picks columns to profiles table
-- Run this in Supabase SQL editor

alter table public.profiles
  add column if not exists master_picks_enabled boolean not null default false;

alter table public.profiles
  add column if not exists master_picks_leagues uuid[] not null default '{}'::uuid[];

-- Backfill NULLs just in case (older rows without defaults)
update public.profiles set master_picks_enabled = false where master_picks_enabled is null;
update public.profiles set master_picks_leagues = '{}'::uuid[] where master_picks_leagues is null;

-- Optionally: add a simple policy (adjust if you already have RLS enabled)
-- ensure RLS is enabled first: alter table public.profiles enable row level security;
-- create policy "profiles_update_master_picks" on public.profiles for update using ( auth.uid() = id );
-- create policy "profiles_select" on public.profiles for select using ( true );

-- To verify after running:
-- select id, master_picks_enabled, master_picks_leagues from public.profiles limit 5;

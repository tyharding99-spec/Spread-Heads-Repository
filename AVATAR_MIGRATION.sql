-- =====================================================
-- AVATAR STORAGE SETUP
-- =====================================================
-- Creates storage bucket and RLS policies for user avatars
-- Run this in Supabase SQL Editor
-- =====================================================

-- Note: The bucket itself must be created via the Supabase Dashboard
-- Go to Storage → Create bucket → Name: 'avatars' → Public: Yes

-- =====================================================
-- STORAGE RLS POLICIES
-- =====================================================

-- Allow users to upload their own avatars
-- Files are organized in folders by user ID: {user_id}/{filename}
CREATE POLICY "Users can upload their own avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow users to update their own avatars
CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow users to delete their own avatars
CREATE POLICY "Users can delete their own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow anyone to view avatars (public bucket)
CREATE POLICY "Anyone can view avatars"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- =====================================================
-- ADD AVATAR_URL TO PROFILES TABLE
-- =====================================================

-- Add avatar_url column to profiles table (if it doesn't exist)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_avatar_url ON profiles(avatar_url);

-- =====================================================
-- MANUAL STEPS IN SUPABASE DASHBOARD
-- =====================================================
-- 1. Go to Storage in Supabase Dashboard
-- 2. Click "New bucket"
-- 3. Name: avatars
-- 4. Public bucket: YES (checked)
-- 5. Click "Create bucket"
-- 6. Then run this SQL script
-- =====================================================

-- =====================================================
-- VERIFICATION
-- =====================================================
-- Check if policies exist:
-- SELECT * FROM pg_policies WHERE tablename = 'objects' AND policyname LIKE '%avatar%';

-- Check if profiles has avatar_url column:
-- SELECT column_name FROM information_schema.columns 
-- WHERE table_name = 'profiles' AND column_name = 'avatar_url';
-- =====================================================

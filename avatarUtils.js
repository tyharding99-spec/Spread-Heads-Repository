// =====================================================
// AVATAR UTILITIES
// =====================================================
// Avatar upload and management for user profiles
// Uses Supabase Storage for cloud storage
// =====================================================

import { supabase } from './supabaseClient';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';

const AVATAR_BUCKET = 'avatars';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// =====================================================
// PERMISSIONS
// =====================================================

/**
 * Request camera roll permissions
 */
export const requestMediaLibraryPermissions = async () => {
  if (Platform.OS !== 'web') {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission Denied',
        'We need access to your photos to upload an avatar.'
      );
      return false;
    }
  }
  return true;
};

// =====================================================
// IMAGE PICKING
// =====================================================

/**
 * Pick an image from the device's media library
 * @returns {Object|null} - Image data or null if cancelled
 */
export const pickAvatar = async () => {
  try {
    const hasPermission = await requestMediaLibraryPermissions();
    if (!hasPermission) return null;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1], // Square crop
      quality: 0.8, // Compress to reduce file size
    });

    if (result.canceled) {
      return null;
    }

    const asset = result.assets[0];
    
    // Check file size
    if (asset.fileSize && asset.fileSize > MAX_FILE_SIZE) {
      Alert.alert(
        'File Too Large',
        'Please select an image smaller than 5MB.'
      );
      return null;
    }

    return asset;
  } catch (error) {
    console.error('Error picking avatar:', error);
    Alert.alert('Error', 'Failed to pick image');
    return null;
  }
};

// =====================================================
// UPLOAD
// =====================================================

/**
 * Upload avatar to Supabase Storage
 * @param {string} userId - User's ID
 * @param {Object} imageAsset - Image asset from picker
 * @returns {Object} - { url, error }
 */
export const uploadAvatar = async (userId, imageAsset) => {
  try {
    if (!userId || !imageAsset) {
      return { url: null, error: 'Missing user ID or image' };
    }

    const { uri } = imageAsset;
    const ext = uri.split('.').pop()?.toLowerCase() || 'jpg';
    const fileName = `${userId}-${Date.now()}.${ext}`;
    const filePath = `${userId}/${fileName}`;

    // For React Native, fetch the file and convert to blob
    const response = await fetch(uri);
    const blob = await response.blob();

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(filePath, blob, {
        contentType: imageAsset.type || 'image/jpeg',
        upsert: false,
      });

    if (error) {
      console.error('Upload error:', error);
      return { url: null, error: error.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(AVATAR_BUCKET)
      .getPublicUrl(filePath);

    return { url: urlData.publicUrl, error: null };
  } catch (error) {
    console.error('Upload exception:', error);
    return { url: null, error: error.message };
  }
};

// =====================================================
// DELETE
// =====================================================

/**
 * Delete user's old avatar from storage
 * @param {string} avatarUrl - Full URL of the avatar to delete
 */
export const deleteAvatar = async (avatarUrl) => {
  try {
    if (!avatarUrl) return;

    // Extract file path from URL
    const urlParts = avatarUrl.split('/');
    const bucketIndex = urlParts.indexOf(AVATAR_BUCKET);
    if (bucketIndex === -1) return;

    const filePath = urlParts.slice(bucketIndex + 1).join('/');

    const { error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .remove([filePath]);

    if (error) {
      console.warn('Failed to delete old avatar:', error);
    }
  } catch (error) {
    console.warn('Delete avatar exception:', error);
  }
};

// =====================================================
// COMPLETE FLOW
// =====================================================

/**
 * Complete avatar update flow: pick, upload, update profile
 * @param {string} userId - User's ID
 * @param {string} currentAvatarUrl - Current avatar URL (to delete old one)
 * @param {Function} onSuccess - Callback with new avatar URL
 * @returns {Promise<boolean>} - Success status
 */
export const updateUserAvatar = async (userId, currentAvatarUrl, onSuccess) => {
  try {
    // Step 1: Pick image
    const image = await pickAvatar();
    if (!image) return false; // User cancelled

    // Step 2: Upload new avatar
    const { url, error } = await uploadAvatar(userId, image);
    if (error) {
      Alert.alert('Upload Failed', error);
      return false;
    }

    // Step 3: Update profile in Supabase
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ avatar_url: url })
      .eq('id', userId);

    if (updateError) {
      Alert.alert('Error', 'Failed to update profile');
      return false;
    }

    // Step 4: Delete old avatar (if exists)
    if (currentAvatarUrl) {
      await deleteAvatar(currentAvatarUrl);
    }

    // Step 5: Success callback
    if (onSuccess) {
      onSuccess(url);
    }

    Alert.alert('Success', 'Avatar updated!');
    return true;
  } catch (error) {
    console.error('Avatar update flow error:', error);
    Alert.alert('Error', 'Failed to update avatar');
    return false;
  }
};

// =====================================================
// BUCKET SETUP (RUN ONCE IN SUPABASE)
// =====================================================

/**
 * To enable avatar uploads, create the bucket in Supabase:
 * 
 * 1. Go to Storage in Supabase Dashboard
 * 2. Create a new bucket named 'avatars'
 * 3. Make it PUBLIC
 * 4. Add RLS policies:
 * 
 * -- Allow users to upload their own avatars
 * CREATE POLICY "Users can upload their own avatar"
 *   ON storage.objects FOR INSERT
 *   WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
 * 
 * -- Allow users to update their own avatars
 * CREATE POLICY "Users can update their own avatar"
 *   ON storage.objects FOR UPDATE
 *   WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
 * 
 * -- Allow users to delete their own avatars
 * CREATE POLICY "Users can delete their own avatar"
 *   ON storage.objects FOR DELETE
 *   USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
 * 
 * -- Allow anyone to view avatars (public bucket)
 * CREATE POLICY "Anyone can view avatars"
 *   ON storage.objects FOR SELECT
 *   USING (bucket_id = 'avatars');
 */

export default {
  pickAvatar,
  uploadAvatar,
  deleteAvatar,
  updateUserAvatar,
  requestMediaLibraryPermissions,
};

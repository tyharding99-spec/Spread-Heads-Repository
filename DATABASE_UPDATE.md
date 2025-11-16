# Database Update Required

To enable display names, you need to add a `display_name` column to your `profiles` table in Supabase.

## SQL Migration

Run this SQL in your Supabase SQL Editor:

```sql
-- Add display_name column to profiles table
ALTER TABLE profiles 
ADD COLUMN display_name TEXT;

-- Optional: Add a comment to document the column
COMMENT ON COLUMN profiles.display_name IS 'Public display name shown to other users';
```

## What This Does

- Adds a new optional `display_name` column to store users' public display names
- The display name is what other users will see (e.g., "John Smith")
- The username remains as the unique identifier (e.g., "john_smith_123")
- If no display name is set, the app will fall back to showing the username

## Testing

After running the migration:
1. Sign up a new user and set a display name during registration
2. Edit an existing user's profile to add a display name
3. Check that the display name appears in the banner: "Welcome [Display Name]"
4. Verify the profile shows: Display Name as main heading, @username below it

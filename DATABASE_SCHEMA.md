# Database Schema Setup

## Friend Requests Table

````markdown
# Database Schema Setup

## Overview

This document covers the database schema for social features and server-side scoring.

**Related documentation:**
- Full scoring system details: See `SCORING_SYSTEM.md`
- SQL migration for scoring: See `SCORING_MIGRATION.sql`

---

## Friend Requests Table

Run this SQL in your Supabase SQL Editor to create the friend_requests table:

```sql
-- Create friend_requests table
CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_friend_request UNIQUE(requester_id, recipient_id)
);

-- Create index for faster queries
CREATE INDEX idx_friend_requests_recipient ON friend_requests(recipient_id, status);
CREATE INDEX idx_friend_requests_requester ON friend_requests(requester_id, status);
CREATE INDEX idx_friend_requests_status ON friend_requests(status);

-- Enable Row Level Security
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view requests they're involved in
CREATE POLICY "Users can view their own requests"
  ON friend_requests
  FOR SELECT
  USING (
    auth.uid() = requester_id OR auth.uid() = recipient_id
  );

-- RLS Policy: Users can create requests as requester
CREATE POLICY "Users can send friend requests"
  ON friend_requests
  FOR INSERT
  WITH CHECK (
    auth.uid() = requester_id
  );

-- RLS Policy: Users can update requests they're involved in (with restrictions)
CREATE POLICY "Users can update their requests"
  ON friend_requests
  FOR UPDATE
  USING (
    (auth.uid() = requester_id AND status = 'pending') OR
    (auth.uid() = recipient_id AND status = 'pending')
  )
  WITH CHECK (
    (auth.uid() = requester_id AND status IN ('revoked', 'pending')) OR
    (auth.uid() = recipient_id AND status IN ('accepted', 'declined', 'pending'))
  );

-- RLS Policy: Users can delete their requests
CREATE POLICY "Users can delete their requests"
  ON friend_requests
  FOR DELETE
  USING (
    auth.uid() = requester_id OR auth.uid() = recipient_id
  );

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_friend_requests_updated_at
    BEFORE UPDATE ON friend_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

## Usage

After creating the table, the app will use:
- `createFriendRequest(recipientId)` - Send a request
- `acceptFriendRequest(requestId)` - Accept (changes status to 'accepted')
- `declineFriendRequest(requestId)` - Decline (changes status to 'declined')
- `revokeFriendRequest(requestId)` - Cancel sent request (changes status to 'revoked')
- `listIncomingFriendRequests()` - View requests sent to you
- `listOutgoingFriendRequests()` - View requests you sent
- `listFriends()` - Get all accepted friendships (bidirectional)
- `removeFriend(friendshipId)` - Delete friendship

## Notes

- Friendships are bidirectional: one row with status='accepted' represents both users being friends
- The unique constraint prevents duplicate requests between the same two users
- RLS policies ensure users can only access/modify their own requests
- The `listFriends()` function queries both requester_id and recipient_id to find all friendships

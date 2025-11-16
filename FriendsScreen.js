import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, Alert, ActivityIndicator } from 'react-native';
import { loadFriends, saveFriends } from './storage';
import { computeUserStats } from './stats';
import { loadResults } from './storage';
import { getProfilesByIds, searchProfilesByUsername } from './supabaseProfile';
import { listPendingInvitesForUser, acceptInvite, declineInvite } from './supabaseInvites';
import { addUserToLeague } from './supabaseLeague';
import { notifyFriendRequest, notifyFriendRequestAccepted } from './notifications';
import { 
  createFriendRequest, 
  acceptFriendRequest, 
  declineFriendRequest, 
  revokeFriendRequest,
  listIncomingFriendRequests, 
  listOutgoingFriendRequests,
  listFriends,
  removeFriend 
} from './supabaseFriends';

export const FriendsScreen = ({ currentUser, leagues, setLeagues, theme, onViewProfile, onBack }) => {
  const [friends, setFriends] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [outgoingRequests, setOutgoingRequests] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [friendStats, setFriendStats] = useState({});
  const [isPublic, setIsPublic] = useState(true); // User's stats visibility
  const [pendingInvites, setPendingInvites] = useState([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [activeTab, setActiveTab] = useState('friends'); // 'friends' | 'incoming' | 'outgoing'

  useEffect(() => {
    loadFriendsData();
    loadFriendRequests();
  }, [currentUser]);

  useEffect(() => {
    if (currentUser?.id) {
      refreshInvites();
    }
  }, [currentUser]);

  useEffect(() => {
    // Load stats for all friends
    loadAllFriendStats();
  }, [friends, leagues]);

  // Debounced search for profiles
  useEffect(() => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const { data, error } = await searchProfilesByUsername(searchQuery.trim());
        if (!error) {
          // Filter out current user and existing friends
          const filtered = (data || []).filter(p => 
            p.id !== currentUser?.id && !friends.some(f => f.userId === p.id)
          );
          setSearchResults(filtered);
        }
      } catch (e) {
        console.warn('Search error:', e);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, currentUser, friends]);

  const loadFriendsData = async () => {
    try {
      // Load from Supabase friend_requests table
      const { data, error } = await listFriends();
      if (!error && data) {
        setFriends(data);
      }
      
      // Also load legacy local friends and isPublic setting
      const localData = await loadFriends(currentUser?.id);
      setIsPublic(localData.isPublic !== false);
    } catch (e) {
      console.warn('Failed to load friends:', e);
    }
  };

  const loadFriendRequests = async () => {
    try {
      const [incoming, outgoing] = await Promise.all([
        listIncomingFriendRequests('pending'),
        listOutgoingFriendRequests('pending')
      ]);
      
      if (!incoming.error) setIncomingRequests(incoming.data || []);
      if (!outgoing.error) setOutgoingRequests(outgoing.data || []);
    } catch (e) {
      console.warn('Failed to load friend requests:', e);
    }
  };

  const loadAllFriendStats = async () => {
    try {
      const results = await loadResults();
      const stats = {};
      
      friends.forEach(friend => {
        if (friend.isPublic) {
          const s = computeUserStats({
            leagues: leagues || [],
            userId: friend.userId,
            results,
            pickType: 'all',
            timePeriod: 'allTime',
          });
          stats[friend.userId] = s;
        }
      });
      
      setFriendStats(stats);
    } catch (e) {
      console.warn('Failed to load friend stats:', e);
    }
  };

  const refreshInvites = async () => {
    try {
      setLoadingInvites(true);
      const { data, error } = await listPendingInvitesForUser(currentUser?.id);
      if (!error) setPendingInvites(data || []);
    } catch (e) {
      console.warn('Failed to load invites:', e);
    } finally {
      setLoadingInvites(false);
    }
  };

  const handleAcceptInvite = async (invite) => {
    try {
      const { data: acceptData, error: acceptError } = await acceptInvite(invite.id);
      if (acceptError) {
        Alert.alert('Error', acceptError.message || 'Failed to accept invite');
        return;
      }
      // Add user to league server-side
      const { data: leagueUpdate, error: leagueErr } = await addUserToLeague(invite.league_code, currentUser?.id);
      if (leagueErr) {
        Alert.alert('Error', leagueErr.message || 'Failed adding to league');
      } else {
        // Update local leagues state
        setLeagues(prev => prev.map(l => l.code === invite.league_code ? { ...l, members: leagueUpdate.members } : l));
        Alert.alert('Joined League', 'You have joined the league!');
      }
      refreshInvites();
    } catch (e) {
      Alert.alert('Error', e.message || 'Unexpected error');
    }
  };

  const handleDeclineInvite = async (invite) => {
    try {
      const { error } = await declineInvite(invite.id);
      if (error) {
        Alert.alert('Error', error.message || 'Failed to decline invite');
        return;
      }
      refreshInvites();
    } catch (e) {
      Alert.alert('Error', e.message || 'Unexpected error');
    }
  };

  const handleSendFriendRequest = async (recipientId, recipientUsername) => {
    try {
      const { data, error } = await createFriendRequest(recipientId);
      if (error) {
        Alert.alert('Error', error.message || 'Failed to send friend request');
        return;
      }
      Alert.alert('Request Sent', `Friend request sent to ${recipientUsername}!`);
      
      // Notify recipient (they'll see it when they open the app)
      // Note: In production, you'd use server-side push via Expo push notifications service
      // For now, this schedules a local notification that fires immediately
      await notifyFriendRequest(currentUser?.username || 'Someone');
      
      setSearchQuery('');
      setSearchResults([]);
      loadFriendRequests();
    } catch (e) {
      Alert.alert('Error', e.message || 'Unexpected error');
    }
  };

  const handleAcceptFriendRequest = async (request) => {
    try {
      const { data, error } = await acceptFriendRequest(request.id);
      if (error) {
        Alert.alert('Error', error.message || 'Failed to accept request');
        return;
      }
      Alert.alert('Friend Added', `You are now friends with ${request.requester?.username || 'this user'}!`);
      
      // Notify the requester that their request was accepted
      await notifyFriendRequestAccepted(currentUser?.username || 'Someone');
      
      loadFriendsData();
      loadFriendRequests();
    } catch (e) {
      Alert.alert('Error', e.message || 'Unexpected error');
    }
  };

  const handleDeclineFriendRequest = async (request) => {
    try {
      const { data, error } = await declineFriendRequest(request.id);
      if (error) {
        Alert.alert('Error', error.message || 'Failed to decline request');
        return;
      }
      loadFriendRequests();
    } catch (e) {
      Alert.alert('Error', e.message || 'Unexpected error');
    }
  };

  const handleRevokeFriendRequest = async (request) => {
    try {
      const { data, error } = await revokeFriendRequest(request.id);
      if (error) {
        Alert.alert('Error', error.message || 'Failed to cancel request');
        return;
      }
      loadFriendRequests();
    } catch (e) {
      Alert.alert('Error', e.message || 'Unexpected error');
    }
  };

  const handleRemoveFriend = async (friend) => {
    Alert.alert(
      'Remove Friend',
      `Remove ${friend.displayName || friend.username} from your friends?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const { error } = await removeFriend(friend.friendshipId);
              if (error) {
                Alert.alert('Error', error.message || 'Failed to remove friend');
                return;
              }
              loadFriendsData();
            } catch (e) {
              Alert.alert('Error', e.message || 'Unexpected error');
            }
          },
        },
      ]
    );
  };

  const toggleStatsVisibility = async () => {
    const newVisibility = !isPublic;
    setIsPublic(newVisibility);
    await saveFriends(currentUser?.id, { friends: [], requests: [], isPublic: newVisibility });
    Alert.alert(
      'Stats Visibility Updated',
      newVisibility ? 'Your stats are now public to friends' : 'Your stats are now private'
    );
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme?.colors?.bannerBg }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Pressable onPress={onBack} style={{ marginRight: 12 }}>
            <Text style={{ fontSize: 24, color: theme?.colors?.heading }}>←</Text>
          </Pressable>
          <Text style={[styles.h1, { color: theme?.colors?.heading }]}>Friends</Text>
        </View>
      </View>

      {/* Privacy Setting */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginTop: 16 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>
              Public Stats
            </Text>
            <Text style={{ fontSize: 13, color: theme?.colors?.muted, marginTop: 2 }}>
              {isPublic ? 'Friends can see your stats' : 'Your stats are private'}
            </Text>
          </View>
          <Pressable
            onPress={toggleStatsVisibility}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: isPublic ? theme?.colors?.success : theme?.colors?.border,
            }}
          >
            <Text style={{ color: isPublic ? '#fff' : theme?.colors?.text, fontWeight: '600' }}>
              {isPublic ? 'Public' : 'Private'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Add Friend */}
      <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Add Friend</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            style={[styles.input, { flex: 1, backgroundColor: theme?.colors?.card, color: theme?.colors?.text }]}
            placeholder="Search by username or name"
            placeholderTextColor={theme?.colors?.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchLoading && (
            <View style={{ justifyContent: 'center', paddingHorizontal: 12 }}>
              <ActivityIndicator size="small" color={theme?.colors?.primary} />
            </View>
          )}
        </View>
        
        {/* Search Results */}
        {searchResults.length > 0 && (
          <View style={{ marginTop: 12 }}>
            {searchResults.map(profile => {
              const alreadyFriend = friends.some(f => f.userId === profile.id);
              const requestSent = outgoingRequests.some(r => r.recipient_id === profile.id);
              
              return (
                <View key={profile.id} style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme?.colors?.text, fontWeight: '600' }}>
                      {profile.display_name || profile.username}
                    </Text>
                    {profile.display_name && (
                      <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>@{profile.username}</Text>
                    )}
                  </View>
                  {alreadyFriend ? (
                    <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>Already friends</Text>
                  ) : requestSent ? (
                    <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>Request sent</Text>
                  ) : (
                    <Pressable
                      onPress={() => handleSendFriendRequest(profile.id, profile.username)}
                      style={{
                        backgroundColor: theme?.colors?.primary,
                        paddingHorizontal: 16,
                        paddingVertical: 8,
                        borderRadius: 8,
                      }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '600' }}>Add</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        )}
        
        {searchQuery.trim().length >= 2 && !searchLoading && searchResults.length === 0 && (
          <Text style={{ fontSize: 12, color: theme?.colors?.muted, marginTop: 8 }}>
            No users found matching "{searchQuery}"
          </Text>
        )}
        
        {searchQuery.trim().length < 2 && searchQuery.trim().length > 0 && (
          <Text style={{ fontSize: 12, color: theme?.colors?.muted, marginTop: 8 }}>
            Type at least 2 characters to search
          </Text>
        )}
      </View>

      {/* Pending League Invites */}
      <View style={{ paddingHorizontal: 16, marginTop: 32 }}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>League Invites</Text>
        {loadingInvites && (
          <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>Loading invites...</Text>
        )}
        {(!pendingInvites || pendingInvites.length === 0) && !loadingInvites && (
          <Text style={{ color: theme?.colors?.muted, fontSize: 13 }}>No pending invites.</Text>
        )}
        {pendingInvites.map(inv => (
          <View key={inv.id} style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}>
            <Text style={{ color: theme?.colors?.text, fontWeight: '600', marginBottom: 4 }}>League: {inv.league_code}</Text>
            <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginBottom: 8 }}>Invited by: {inv.inviter_id?.slice(0,8)} • {new Date(inv.created_at).toLocaleString()}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable onPress={() => handleAcceptInvite(inv)} style={{ flex:1, backgroundColor: theme?.colors?.success, padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Accept</Text>
              </Pressable>
              <Pressable onPress={() => handleDeclineInvite(inv)} style={{ flex:1, backgroundColor: theme?.colors?.danger, padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Decline</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>

      {/* Friends List */}
      <View style={{ paddingHorizontal: 16, marginTop: 24, marginBottom: 24 }}>
        {/* Tabs */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          <Pressable
            onPress={() => setActiveTab('friends')}
            style={[
              { flex: 1, padding: 12, borderRadius: 8, alignItems: 'center' },
              activeTab === 'friends' ? { backgroundColor: theme?.colors?.primary } : { backgroundColor: theme?.colors?.card }
            ]}
          >
            <Text style={{ color: activeTab === 'friends' ? '#fff' : theme?.colors?.text, fontWeight: '600' }}>
              Friends ({friends.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab('incoming')}
            style={[
              { flex: 1, padding: 12, borderRadius: 8, alignItems: 'center' },
              activeTab === 'incoming' ? { backgroundColor: theme?.colors?.primary } : { backgroundColor: theme?.colors?.card }
            ]}
          >
            <Text style={{ color: activeTab === 'incoming' ? '#fff' : theme?.colors?.text, fontWeight: '600' }}>
              Requests ({incomingRequests.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab('outgoing')}
            style={[
              { flex: 1, padding: 12, borderRadius: 8, alignItems: 'center' },
              activeTab === 'outgoing' ? { backgroundColor: theme?.colors?.primary } : { backgroundColor: theme?.colors?.card }
            ]}
          >
            <Text style={{ color: activeTab === 'outgoing' ? '#fff' : theme?.colors?.text, fontWeight: '600' }}>
              Sent ({outgoingRequests.length})
            </Text>
          </Pressable>
        </View>

        {/* Friends Tab */}
        {activeTab === 'friends' && (
          <>
            <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>
              My Friends
            </Text>

            {friends.length === 0 ? (
              <View style={[styles.card, { backgroundColor: theme?.colors?.card, paddingVertical: 40, alignItems: 'center' }]}>
                <Text style={{ fontSize: 40, marginBottom: 12 }}>👥</Text>
                <Text style={{ color: theme?.colors?.muted, textAlign: 'center' }}>
                  No friends yet. Search and send friend requests above!
                </Text>
              </View>
            ) : (
              friends.map((friend) => {
                const stats = friendStats[friend.userId];
                const hasStats = stats;
                const displayLabel = friend.displayName || friend.username;
                const avatarLetter = (displayLabel || '?')[0]?.toUpperCase() || '?';

                return (
                  <Pressable
                    key={friend.userId}
                    onPress={() => onViewProfile(friend.userId, displayLabel)}
                    style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                        {/* Avatar */}
                        <View style={{
                          width: 50,
                          height: 50,
                          borderRadius: 25,
                          backgroundColor: theme?.colors?.primary,
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginRight: 12,
                        }}>
                          <Text style={{ fontSize: 20, fontWeight: '700', color: '#fff' }}>{avatarLetter}</Text>
                        </View>

                        {/* Info */}
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>
                            {displayLabel}
                          </Text>
                          {hasStats ? (
                            <Text style={{ fontSize: 13, color: theme?.colors?.muted, marginTop: 2 }}>
                              {stats.winPercentage}% • {stats.overallWins}-{stats.overallLosses} • {stats.totalPicks} picks
                            </Text>
                          ) : (
                            <Text style={{ fontSize: 13, color: theme?.colors?.muted, marginTop: 2 }}>
                              No picks yet
                            </Text>
                          )}
                        </View>

                        {/* Remove Button */}
                        <Pressable
                          onPress={(e) => {
                            e.stopPropagation();
                            handleRemoveFriend(friend);
                          }}
                          style={{ padding: 8 }}
                        >
                          <Text style={{ fontSize: 20, color: theme?.colors?.error }}>×</Text>
                        </Pressable>
                      </View>
                    </View>
                  </Pressable>
                );
              })
            )}
          </>
        )}

        {/* Incoming Requests Tab */}
        {activeTab === 'incoming' && (
          <>
            <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>
              Friend Requests
            </Text>

            {incomingRequests.length === 0 ? (
              <View style={[styles.card, { backgroundColor: theme?.colors?.card, paddingVertical: 40, alignItems: 'center' }]}>
                <Text style={{ fontSize: 40, marginBottom: 12 }}>📬</Text>
                <Text style={{ color: theme?.colors?.muted, textAlign: 'center' }}>
                  No pending friend requests
                </Text>
              </View>
            ) : (
              incomingRequests.map((request) => {
                const requester = request.requester;
                const displayLabel = requester?.display_name || requester?.username || 'Unknown';
                
                return (
                  <View key={request.id} style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: theme?.colors?.text, fontWeight: '600', fontSize: 16 }}>
                          {displayLabel}
                        </Text>
                        {requester?.display_name && (
                          <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>@{requester.username}</Text>
                        )}
                        <Text style={{ color: theme?.colors?.muted, fontSize: 11, marginTop: 4 }}>
                          {new Date(request.created_at).toLocaleString()}
                        </Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Pressable
                        onPress={() => handleAcceptFriendRequest(request)}
                        style={{ flex: 1, backgroundColor: theme?.colors?.success, padding: 10, borderRadius: 8, alignItems: 'center' }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '600' }}>Accept</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => handleDeclineFriendRequest(request)}
                        style={{ flex: 1, backgroundColor: theme?.colors?.danger, padding: 10, borderRadius: 8, alignItems: 'center' }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '600' }}>Decline</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}

        {/* Outgoing Requests Tab */}
        {activeTab === 'outgoing' && (
          <>
            <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>
              Sent Requests
            </Text>

            {outgoingRequests.length === 0 ? (
              <View style={[styles.card, { backgroundColor: theme?.colors?.card, paddingVertical: 40, alignItems: 'center' }]}>
                <Text style={{ fontSize: 40, marginBottom: 12 }}>📤</Text>
                <Text style={{ color: theme?.colors?.muted, textAlign: 'center' }}>
                  No pending outgoing requests
                </Text>
              </View>
            ) : (
              outgoingRequests.map((request) => {
                const recipient = request.recipient;
                const displayLabel = recipient?.display_name || recipient?.username || 'Unknown';
                
                return (
                  <View key={request.id} style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: theme?.colors?.text, fontWeight: '600', fontSize: 16 }}>
                          {displayLabel}
                        </Text>
                        {recipient?.display_name && (
                          <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>@{recipient.username}</Text>
                        )}
                        <Text style={{ color: theme?.colors?.muted, fontSize: 11, marginTop: 4 }}>
                          Sent {new Date(request.created_at).toLocaleString()}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => handleRevokeFriendRequest(request)}
                        style={{ backgroundColor: theme?.colors?.muted, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '600' }}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 20, paddingTop: 60, paddingBottom: 24 },
  h1: { fontSize: 28, fontWeight: '700' },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  card: { borderRadius: 12, padding: 16 },
  input: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, fontSize: 16 },
});

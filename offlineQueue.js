import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { savePick } from './supabasePicks';

const QUEUE_KEY = 'offline:pick_queue';
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

/**
 * Offline pick queue system
 * Queues failed pick saves and retries them when connectivity is restored
 */

/**
 * Get the current pick queue
 * @returns {Promise<Array>} Array of queued picks
 */
async function getQueue() {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const queue = JSON.parse(raw);
    return Array.isArray(queue) ? queue : [];
  } catch (e) {
    console.warn('Failed to read pick queue:', e);
    return [];
  }
}

/**
 * Save the pick queue
 * @param {Array} queue - Array of picks to queue
 */
async function saveQueue(queue) {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn('Failed to save pick queue:', e);
  }
}

/**
 * Add a pick to the offline queue
 * @param {object} pick - Pick object with leagueCode, userId, gameId, spread, total, winner
 * @returns {Promise<void>}
 */
export async function queueOfflinePick(pick) {
  try {
    const queue = await getQueue();
    const queuedPick = {
      ...pick,
      queuedAt: new Date().toISOString(),
      retries: 0,
      id: `${pick.leagueCode}_${pick.userId}_${pick.gameId}_${Date.now()}`,
    };
    
    // Check if this pick is already queued (avoid duplicates)
    const exists = queue.find(
      p => p.leagueCode === pick.leagueCode && 
           p.userId === pick.userId && 
           p.gameId === pick.gameId
    );
    
    if (exists) {
      // Update existing queued pick
      const updated = queue.map(p => 
        p.leagueCode === pick.leagueCode && 
        p.userId === pick.userId && 
        p.gameId === pick.gameId
          ? { ...queuedPick, retries: p.retries }
          : p
      );
      await saveQueue(updated);
      console.log(`📝 Updated queued pick: ${pick.gameId} in ${pick.leagueCode}`);
    } else {
      // Add new queued pick
      queue.push(queuedPick);
      await saveQueue(queue);
      console.log(`📝 Queued offline pick: ${pick.gameId} in ${pick.leagueCode}`);
    }
  } catch (e) {
    console.error('Failed to queue offline pick:', e);
  }
}

/**
 * Process the offline pick queue
 * Attempts to save all queued picks to Supabase
 * @returns {Promise<{processed: number, failed: number, remaining: number}>}
 */
export async function processOfflineQueue() {
  try {
    const queue = await getQueue();
    if (queue.length === 0) {
      return { processed: 0, failed: 0, remaining: 0 };
    }
    
    console.log(`🔄 Processing ${queue.length} queued picks...`);
    
    const results = {
      processed: 0,
      failed: 0,
      remaining: 0,
    };
    
    const remainingQueue = [];
    
    for (const queuedPick of queue) {
      try {
        // Attempt to save pick to Supabase
        const { error } = await savePick({
          league_code: queuedPick.leagueCode,
          user_id: queuedPick.userId,
          game_id: queuedPick.gameId,
          week: queuedPick.week || null,
          spread: queuedPick.spread ?? null,
          total: queuedPick.total ?? null,
          winner: queuedPick.winner ?? null,
        });
        
        if (error) {
          // Failed - check if we should retry
          if (queuedPick.retries < MAX_RETRIES) {
            remainingQueue.push({
              ...queuedPick,
              retries: queuedPick.retries + 1,
              lastError: error.message,
            });
            results.failed++;
            console.warn(`❌ Failed to save queued pick (retry ${queuedPick.retries + 1}/${MAX_RETRIES}):`, error);
          } else {
            // Max retries exceeded, drop from queue
            console.error(`❌ Max retries exceeded for pick ${queuedPick.gameId}, dropping from queue`);
            results.failed++;
          }
        } else {
          // Success
          results.processed++;
          console.log(`✅ Processed queued pick: ${queuedPick.gameId} in ${queuedPick.leagueCode}`);
        }
        
        // Small delay between requests to avoid rate limiting
        if (queue.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (e) {
        console.error('Error processing queued pick:', e);
        // Keep in queue for retry
        if (queuedPick.retries < MAX_RETRIES) {
          remainingQueue.push({
            ...queuedPick,
            retries: queuedPick.retries + 1,
          });
        }
        results.failed++;
      }
    }
    
    // Save remaining queue
    results.remaining = remainingQueue.length;
    await saveQueue(remainingQueue);
    
    console.log(`📊 Queue processing complete: ${results.processed} processed, ${results.failed} failed, ${results.remaining} remaining`);
    
    return results;
  } catch (e) {
    console.error('Failed to process offline queue:', e);
    return { processed: 0, failed: 0, remaining: 0 };
  }
}

/**
 * Get the current queue size
 * @returns {Promise<number>}
 */
export async function getQueueSize() {
  const queue = await getQueue();
  return queue.length;
}

/**
 * Clear the offline queue (use with caution)
 * @returns {Promise<void>}
 */
export async function clearQueue() {
  await saveQueue([]);
  console.log('🗑️ Offline pick queue cleared');
}

/**
 * Setup automatic queue processing
 * Listens for network connectivity changes and processes queue when online
 * @param {function} onQueueProcessed - Optional callback when queue is processed
 * @returns {function} Cleanup function to stop listening
 */
export function setupAutoQueueProcessing(onQueueProcessed) {
  let isProcessing = false;
  
  const unsubscribe = NetInfo.addEventListener(async (state) => {
    // Only process when we transition to connected
    if (state.isConnected && !isProcessing) {
      const queueSize = await getQueueSize();
      if (queueSize > 0) {
        console.log(`🌐 Network connected, processing ${queueSize} queued picks...`);
        isProcessing = true;
        
        try {
          const results = await processOfflineQueue();
          if (onQueueProcessed) {
            onQueueProcessed(results);
          }
        } finally {
          isProcessing = false;
        }
      }
    }
  });
  
  console.log('🔌 Auto queue processing enabled');
  
  return () => {
    unsubscribe();
    console.log('🔌 Auto queue processing disabled');
  };
}

/**
 * Check if device is currently online
 * @returns {Promise<boolean>}
 */
export async function isOnline() {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true;
  } catch (e) {
    console.warn('Failed to check network state:', e);
    return true; // Assume online if check fails
  }
}

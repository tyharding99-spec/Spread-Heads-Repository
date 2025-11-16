// =====================================================
// ERROR & METRICS LOGGING
// =====================================================
// Client-side logging utility
// Supports both Supabase and console logging
// =====================================================

import { supabase } from './supabaseClient';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Configuration
const CONFIG = {
  enableSupabaseLogging: true, // Toggle to disable remote logging
  enableConsoleLogging: __DEV__, // Only console.log in development
  batchSize: 10, // Send logs in batches
  flushInterval: 30000, // Flush every 30 seconds
  maxRetries: 3,
  retryDelay: 2000,
};

// In-memory log queue for batching
let logQueue = [];
let flushTimer = null;
let isProcessing = false;

// Get app metadata
const getAppMetadata = () => ({
  platform: Platform.OS,
  platformVersion: Platform.Version,
  userAgent: Platform.select({
    ios: `iOS/${Platform.Version}`,
    android: `Android/${Platform.Version}`,
    default: 'unknown',
  }),
});

// =====================================================
// CORE LOGGING FUNCTIONS
// =====================================================

/**
 * Log an error
 * @param {string} category - Error category (e.g., 'pick_save', 'auth', 'network')
 * @param {string} message - Error message
 * @param {Error|Object} error - Error object or additional details
 */
export const logError = async (category, message, error = {}) => {
  const logEntry = createLogEntry('error', category, message, error);
  
  if (CONFIG.enableConsoleLogging) {
    console.error(`[${category}]`, message, error);
  }
  
  await queueLog(logEntry);
};

/**
 * Log a warning
 * @param {string} category - Warning category
 * @param {string} message - Warning message
 * @param {Object} details - Additional details
 */
export const logWarning = async (category, message, details = {}) => {
  const logEntry = createLogEntry('warning', category, message, details);
  
  if (CONFIG.enableConsoleLogging) {
    console.warn(`[${category}]`, message, details);
  }
  
  await queueLog(logEntry);
};

/**
 * Log an info message
 * @param {string} category - Info category
 * @param {string} message - Info message
 * @param {Object} details - Additional details
 */
export const logInfo = async (category, message, details = {}) => {
  const logEntry = createLogEntry('info', category, message, details);
  
  if (CONFIG.enableConsoleLogging) {
    console.log(`[${category}]`, message, details);
  }
  
  await queueLog(logEntry);
};

/**
 * Log a metric or event
 * @param {string} category - Metric category
 * @param {string} message - Metric name
 * @param {Object} details - Metric data (value, duration, etc.)
 */
export const logMetric = async (category, message, details = {}) => {
  const logEntry = createLogEntry('metric', category, message, details);
  
  if (CONFIG.enableConsoleLogging) {
    console.log(`[METRIC][${category}]`, message, details);
  }
  
  await queueLog(logEntry);
};

// =====================================================
// LOG ENTRY CREATION
// =====================================================

/**
 * Create a standardized log entry
 */
const createLogEntry = (logType, category, message, errorOrDetails) => {
  const appMetadata = getAppMetadata();
  
  // Extract error details if it's an Error object
  const isError = errorOrDetails instanceof Error;
  const details = isError 
    ? {
        name: errorOrDetails.name,
        message: errorOrDetails.message,
        ...extractErrorDetails(errorOrDetails),
      }
    : errorOrDetails;
  
  const stackTrace = isError ? errorOrDetails.stack : null;
  
  return {
    log_type: logType,
    category,
    message,
    details,
    stack_trace: stackTrace,
    ...appMetadata,
  };
};

/**
 * Extract useful details from an error object
 */
const extractErrorDetails = (error) => {
  const details = {};
  
  // Supabase errors
  if (error.code) details.code = error.code;
  if (error.details) details.errorDetails = error.details;
  if (error.hint) details.hint = error.hint;
  
  // Network errors
  if (error.status) details.status = error.status;
  if (error.statusText) details.statusText = error.statusText;
  
  // Other properties
  Object.keys(error).forEach(key => {
    if (!['name', 'message', 'stack'].includes(key)) {
      details[key] = error[key];
    }
  });
  
  return details;
};

// =====================================================
// BATCH QUEUE MANAGEMENT
// =====================================================

/**
 * Queue a log entry for batched sending
 */
const queueLog = async (logEntry) => {
  if (!CONFIG.enableSupabaseLogging) return;
  
  // Get current user if available
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      logEntry.user_id = user.id;
    }
  } catch (err) {
    // Silent fail - don't want logging to break the app
  }
  
  logQueue.push(logEntry);
  
  // Flush immediately if we hit batch size
  if (logQueue.length >= CONFIG.batchSize) {
    flushLogs();
  } else {
    // Otherwise schedule a flush
    scheduleFlush();
  }
};

/**
 * Schedule a log flush
 */
const scheduleFlush = () => {
  if (flushTimer) return;
  
  flushTimer = setTimeout(() => {
    flushLogs();
  }, CONFIG.flushInterval);
};

/**
 * Flush all queued logs to Supabase
 */
export const flushLogs = async () => {
  if (isProcessing || logQueue.length === 0) return;
  
  isProcessing = true;
  clearTimeout(flushTimer);
  flushTimer = null;
  
  const logsToSend = [...logQueue];
  logQueue = [];
  
  try {
    const { error } = await supabase
      .from('client_logs')
      .insert(logsToSend);
    
    if (error) {
      console.error('Failed to send logs:', error);
      // Re-queue failed logs (max retries handled elsewhere)
      logQueue = [...logsToSend, ...logQueue];
    }
  } catch (err) {
    console.error('Exception sending logs:', err);
    // Re-queue failed logs
    logQueue = [...logsToSend, ...logQueue];
  } finally {
    isProcessing = false;
  }
};

// =====================================================
// CRITICAL ERROR WRAPPER
// =====================================================

/**
 * Wrap critical operations with error logging
 * @param {string} category - Operation category
 * @param {Function} operation - Async operation to execute
 * @param {string} errorMessage - Custom error message
 * @returns {Promise} - Result of operation or null on failure
 */
export const withErrorLogging = async (category, operation, errorMessage = 'Operation failed') => {
  try {
    return await operation();
  } catch (error) {
    await logError(category, errorMessage, error);
    return null;
  }
};

/**
 * Wrap critical operations with timing metrics
 * @param {string} category - Operation category
 * @param {string} metricName - Metric name
 * @param {Function} operation - Async operation to execute
 * @returns {Promise} - Result of operation
 */
export const withMetrics = async (category, metricName, operation) => {
  const startTime = Date.now();
  
  try {
    const result = await operation();
    const duration = Date.now() - startTime;
    
    await logMetric(category, metricName, {
      duration,
      success: true,
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    
    await logMetric(category, metricName, {
      duration,
      success: false,
      error: error.message,
    });
    
    throw error;
  }
};

// =====================================================
// COMMON ERROR CATEGORIES
// =====================================================

export const ErrorCategory = {
  PICK_SAVE: 'pick_save',
  AUTH: 'auth',
  NETWORK: 'network',
  REALTIME: 'realtime',
  NOTIFICATION: 'notification',
  ACHIEVEMENT: 'achievement',
  LEAGUE: 'league',
  FRIEND: 'friend',
  OFFLINE_QUEUE: 'offline_queue',
  DATA_FETCH: 'data_fetch',
  UI: 'ui',
  UNKNOWN: 'unknown',
};

// =====================================================
// INITIALIZATION
// =====================================================

/**
 * Initialize logging system
 * Call this on app start
 */
export const initLogging = () => {
  // Setup automatic flush on app background (if needed)
  // For now, just ensure periodic flushing is active
  scheduleFlush();
  
  if (CONFIG.enableConsoleLogging) {
    console.log('Logging system initialized', CONFIG);
  }
};

/**
 * Shutdown logging system
 * Call this on app close or logout
 */
export const shutdownLogging = async () => {
  clearTimeout(flushTimer);
  await flushLogs();
  
  if (CONFIG.enableConsoleLogging) {
    console.log('Logging system shutdown');
  }
};

// =====================================================
// EXPORTS
// =====================================================

export default {
  logError,
  logWarning,
  logInfo,
  logMetric,
  withErrorLogging,
  withMetrics,
  flushLogs,
  initLogging,
  shutdownLogging,
  ErrorCategory,
};

/**
 * Google Recorder API Client
 *
 * Direct HTTP calls to the Recorder gRPC-web API.
 * Uses SAPISIDHASH authentication extracted from browser cookies.
 */

import { createHash } from 'node:crypto';
import type {
  AuthData,
  Recording,
  Transcript,
  TranscriptSegment,
  RecordingListResponse,
  TranscriptionResponse,
} from './types.js';
import { loadAuth } from './auth.js';

const API_BASE =
  'https://pixelrecorder-pa.clients6.google.com/$rpc/java.com.google.wireless.android.pixel.recorder.protos.PlaybackService';
const ORIGIN = 'https://recorder.google.com';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Authentication
// ============================================================================

/**
 * Compute SAPISIDHASH for Google API authentication.
 * Format: SAPISIDHASH <timestamp>_<sha1(timestamp + " " + sapisid + " " + origin)>
 */
function computeSapisidHash(sapisid: string, origin: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;
  const hash = createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Try to refresh cookies automatically from the dedicated browser profile.
 *
 * This is fully silent — it reuses the persistent login captured by
 * `google-recorder auth` and never touches the macOS Keychain or pops any
 * dialog. Returns fresh AuthData on success, null if a re-login is needed.
 */
async function tryAutoRefresh(authUser: number): Promise<AuthData | null> {
  try {
    const { refreshCookies } = await import('./browser-auth.js');
    const refreshed = await refreshCookies(authUser);
    if (refreshed) {
      return loadAuth();
    }
  } catch {
    // Headless refresh unavailable (Chrome missing, profile gone, etc.).
  }
  return null;
}

/**
 * Last-resort recovery when silent refresh fails: open the one-time login window
 * so the user can re-establish the session. No password is stored or entered —
 * the dedicated profile remembers the account, so this is typically just a Duo
 * approval. Only fires in an interactive terminal; disable with
 * GOOGLE_RECORDER_NO_AUTO_LOGIN=1.
 */
async function tryInteractiveRelogin(authUser: number): Promise<AuthData | null> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return null;
  if (process.env.GOOGLE_RECORDER_NO_AUTO_LOGIN) return null;
  try {
    process.stderr.write('\nYour Recorder session needs a fresh sign-in — opening a login window.\n');
    process.stderr.write('(Account is remembered, so this is usually just a Duo approval. No password is stored.)\n');
    const { browserAuth } = await import('./browser-auth.js');
    await browserAuth(authUser);
    return loadAuth();
  } catch {
    return null;
  }
}

/**
 * Make a single authenticated API request.
 */
function makeApiRequest<T>(
  endpoint: string,
  body: unknown[],
  auth: AuthData
): Promise<Response> {
  const url = `${API_BASE}/${endpoint}`;
  const authHeader = computeSapisidHash(auth.sapisid, ORIGIN);

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'X-Goog-Api-Key': auth.apiKey,
      'Authorization': authHeader,
      'X-Goog-AuthUser': String(auth.authUser),
      'X-User-Agent': 'grpc-web-javascript/0.1',
      'Origin': ORIGIN,
      'Referer': ORIGIN + '/',
      'Cookie': auth.cookies,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Make an authenticated API request with automatic cookie refresh on 401.
 */
async function apiRequest<T>(
  endpoint: string,
  body: unknown[],
  auth: AuthData,
  onAuthRefreshed?: (newAuth: AuthData) => void
): Promise<T> {
  let response = await makeApiRequest(endpoint, body, auth);

  // On 401: silent headless refresh first; if that can't recover, fall back to a
  // one-tap interactive re-login (when running in a terminal). Then retry.
  if (response.status === 401) {
    const freshAuth = (await tryAutoRefresh(auth.authUser)) ?? (await tryInteractiveRelogin(auth.authUser));
    if (freshAuth) {
      process.stderr.write('Authentication refreshed.\n');
      onAuthRefreshed?.(freshAuth);
      response = await makeApiRequest(endpoint, body, freshAuth);
    } else {
      throw new Error(
        'Authentication expired and could not be refreshed automatically.\n' +
        'Run `google-recorder auth` to sign in again (no password stored or prompted).'
      );
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse API response: ${text.substring(0, 200)}`);
  }
}

// ============================================================================
// Public API
// ============================================================================

export class RecorderAPI {
  private auth: AuthData | null = null;

  constructor() {
    this.auth = loadAuth();
  }

  isAuthenticated(): boolean {
    return this.auth !== null && !!this.auth.sapisid;
  }

  /** Called when auto-refresh produces new auth — updates the in-memory copy. */
  private onAuthRefreshed = (newAuth: AuthData): void => {
    this.auth = newAuth;
  };

  private ensureAuth(): AuthData {
    if (!this.auth || !this.auth.sapisid) {
      throw new Error(
        'Not authenticated. Run `google-recorder auth --chrome` to set up authentication.'
      );
    }
    if (!this.auth.apiKey) {
      throw new Error(
        'No API key configured. Extract it from Chrome DevTools:\n' +
        '  1. Open recorder.google.com, open DevTools (Network tab)\n' +
        '  2. Find the "X-Goog-Api-Key" header in any request to pixelrecorder-pa\n' +
        '  3. Run: google-recorder auth --api-key <key>'
      );
    }
    return this.auth;
  }

  /**
   * List recordings, most recent first.
   * @param limit Maximum number of recordings to return (default 50)
   */
  async listRecordings(limit: number = 50): Promise<Recording[]> {
    const auth = this.ensureAuth();

    // GetRecordingList request: [[{"1": timestamp_seconds}], page_size]
    const nowSeconds = Math.floor(Date.now() / 1000);
    const response = await apiRequest<RecordingListResponse>(
      'GetRecordingList',
      [[{ '1': nowSeconds }], limit],
      auth,
      this.onAuthRefreshed
    );

    if (!response || !response[0]) {
      return [];
    }

    return response[0].slice(0, limit).map((item) => {
      const [id, title, createdTimestamp, durationTimestamp, , , location, , , , , , , webId] = item;
      const toMs = (ts: any) => (parseInt(ts?.[0] ?? '0') || 0) * 1000 + Math.floor((Number(ts?.[1]) || 0) / 1000000);
      const createdMs = toMs(createdTimestamp);
      const durationMs = toMs(durationTimestamp);

      return {
        id: (webId as string) || id,
        deviceId: id,
        title: title || new Date(createdMs).toLocaleString(),
        date: new Date(createdMs).toISOString(),
        duration: formatDuration(durationMs),
        durationMs,
        location: location || undefined,
        hasTranscript: true,
      };
    });
  }

  /**
   * Get the transcript for a specific recording.
   * @param recordingId UUID of the recording (web ID)
   */
  async getTranscript(recordingId: string): Promise<Transcript | null> {
    if (!UUID_REGEX.test(recordingId)) {
      throw new Error(`Invalid recording ID format: ${recordingId}. Expected UUID.`);
    }

    const auth = this.ensureAuth();

    const response = await apiRequest<TranscriptionResponse>(
      'GetTranscription',
      [recordingId],
      auth,
      this.onAuthRefreshed
    );

    if (!response || !response[0] || response[0].length === 0) {
      return null;
    }

    const segments: TranscriptSegment[] = [];
    let currentSpeaker = -1;
    let currentText = '';
    let currentStartTime = '00:00';

    for (const segment of response[0]) {
      if (!Array.isArray(segment)) {
        continue;
      }

      const [rawWords] = segment;
      const words = Array.isArray(rawWords)
        ? rawWords.filter((word) => Array.isArray(word))
        : [];

      for (const word of words) {
        const tagged = Array.isArray(word[6]) ? Number(word[6][1]) : 0;
        const speakerId = tagged || (currentSpeaker > 0 ? currentSpeaker : 1);
        if (speakerId !== currentSpeaker) {
          if (currentText) {
            segments.push({
              speaker: `Speaker ${currentSpeaker}`,
              text: currentText.trim(),
              startTime: currentStartTime,
            });
            currentText = '';
          }
          currentSpeaker = speakerId;
          currentStartTime = formatTime(parseInt(word[2]));
        }
        const [text, formatted] = word;
        currentText += (formatted || text) + ' ';
      }
    }

    if (currentText) {
      segments.push({
        speaker: `Speaker ${currentSpeaker}`,
        text: currentText.trim(),
        startTime: currentStartTime,
      });
    }

    const rawText = segments
      .map((s) => `[${s.speaker}] (${s.startTime})\n${s.text}`)
      .join('\n\n');

    return {
      recordingId,
      recordingTitle: '',
      segments,
      rawText,
    };
  }

  /**
   * Search recordings by title (client-side filter).
   */
  async searchRecordings(query: string, limit: number = 20): Promise<Recording[]> {
    const all = await this.listRecordings(100);
    const lowerQuery = query.toLowerCase();
    return all
      .filter((r) => r.title.toLowerCase().includes(lowerQuery))
      .slice(0, limit);
  }

  /**
   * Download audio for a recording.
   * Uses the usercontent.recorder.google.com download endpoint.
   * Returns raw audio bytes and content type.
   */
  async getAudio(recordingId: string): Promise<{ data: Buffer; contentType: string; filename: string }> {
    if (!UUID_REGEX.test(recordingId)) {
      throw new Error(`Invalid recording ID format: ${recordingId}. Expected UUID.`);
    }

    let auth = this.ensureAuth();

    const makeAudioRequest = (a: AuthData) => {
      const url = `https://usercontent.recorder.google.com/download/playback/${recordingId}?authuser=${a.authUser}&download=true`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Cookie': a.cookies,
          'Referer': ORIGIN + '/',
        },
        redirect: 'follow',
      });
    };

    let response = await makeAudioRequest(auth);

    // On 401 or 404 (audio endpoint returns 404 for expired cookies): silent
    // refresh, then one-tap interactive re-login as a fallback.
    if (response.status === 401 || response.status === 404) {
      const freshAuth = (await tryAutoRefresh(auth.authUser)) ?? (await tryInteractiveRelogin(auth.authUser));
      if (freshAuth) {
        process.stderr.write('Authentication refreshed.\n');
        this.auth = freshAuth;
        auth = freshAuth;
        response = await makeAudioRequest(auth);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Audio download failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const contentType = response.headers.get('content-type') || 'audio/mp4';
    const contentDisposition = response.headers.get('content-disposition') || '';

    // Extract filename from Content-Disposition header if present
    let filename = `${recordingId}.m4a`;
    const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
    if (filenameMatch) {
      filename = filenameMatch[1];
    }

    const data = Buffer.from(await response.arrayBuffer());

    return { data, contentType, filename };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

let apiInstance: RecorderAPI | null = null;

export function getRecorderAPI(): RecorderAPI {
  if (!apiInstance) {
    apiInstance = new RecorderAPI();
  }
  return apiInstance;
}

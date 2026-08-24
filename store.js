Storage layer — authenticated, offline-capable, conflict-safe.
//
// The browser no longer touches the database table directly. Every request
// goes through a database function that checks a session token first:
//
//   staff_login      username + password  -> session token (password bcrypt-checked)
//   state_get        token                -> the whole school
//   state_save       token + data         -> conditional write, refuses stale saves
//   student_record   admission no + PIN   -> ONLY that child's records
//
// So even with the site link and the public key, an outsider gets nothing:
// the table itself rejects direct reads and writes.
//
// Vercel → Settings → Environment Variables:
//   VITE_SUPABASE_URL       = https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY  = <publishable / anon key>

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isShared = Boolean(URL_BASE && ANON_KEY);

const MIRROR_KEY  = "school_mirror_v2";
const BASE_KEY    = "school_base_v2";
const PENDING_KEY = "school_pending_v2";
const SCHOOL_KEY = "school_code_v1";
const TOKEN_KEY   = "school_token_v1";
const WHO_KEY     = "school_who_v1";

const readJSON  = (k) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const del       = (k) => { try { localStorage.removeItem(k); } catch (e) {} };

export const hasPendingChanges = () => { try { return localStorage.getItem(PENDING_KEY) === "1"; } catch (e) { return false; } };
const setPending = (v) => { try { v ? localStorage.setItem(PENDING_KEY, "1") : del(PENDING_KEY); } catch (e) {} };
export const hasPendingSave = () => { try { return localStorage.getItem(PENDING_KEY) === "1"; } catch (e) { return false; } };

// Retrying automatically when the signal returns.
//
// Work is never lost — saveRoster writes the device copy before it ever tries
// the network. What was missing is this: without it, a mark entered offline
// sat on the phone until someone happened to open the app again and press
// Save a second time. A teacher who entered a whole class's marks with no
// signal and then went home has no reason to reopen the portal that evening.
//
// The browser's own "online" event fires the moment the phone reconnects —
// no polling, no cost while offline.
let retrying = false;
let onSynced = null;
export const onSyncStateChange = (cb) => { onSynced = cb; };

async function retryPendingSave() {
  if (retrying || !hasPendingSave() || !isShared) return;
  retrying = true;
  try {
    const local = readJSON(MIRROR_KEY);
    if (local) {
      await saveRoster(local);
      onSynced?.("synced");
    }
  } catch (e) {
    // still cannot reach the database — stay pending, try again next time
    // the browser tells us we are back online
  } finally {
    retrying = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", retryPendingSave);
  // a phone can regain a weak signal without firing "online" reliably, so a
  // slow background check catches what the event misses — cheap, because it
  // does nothing at all unless there is genuinely a save waiting
  setInterval(() => { if (hasPendingSave()) retryPendingSave(); }, 45000);
}
export const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
export const getWho   = () => readJSON(WHO_KEY);
const setSession = (token, who) => {
  if (token) { try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {} writeJSON(WHO_KEY, who); }
  else { del(TOKEN_KEY); del(WHO_KEY); }
};

let lastSeenUpdatedAt = null;

async function rpc(fn, args) {

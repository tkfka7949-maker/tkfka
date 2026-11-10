// 잠소리 — 기기 안 저장소 (IndexedDB)
// 밤 기록(소리 특징)과 확인용 클립(WAV)을 이 기기 브라우저에만 저장합니다. 서버로 보내지 않아요.
// IndexedDB를 못 쓰는 환경(사생활 보호 모드 등)에서는 메모리에만 두고, 새로고침하면 사라집니다.

const DB_NAME = 'jamsori';
const DB_VER = 1;
let dbp = null;
const mem = { nights: new Map(), clips: new Map() };
let useMem = false;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('nights')) db.createObjectStore('nights', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('clips')) {
          const s = db.createObjectStore('clips', { keyPath: 'id' });
          s.createIndex('nightId', 'nightId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { useMem = true; resolve(null); };
      req.onblocked = () => { useMem = true; resolve(null); };
    } catch {
      useMem = true;
      resolve(null);
    }
  });
  return dbp;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function isPersistent() {
  return !useMem;
}

export async function putNight(night) {
  const db = await open();
  if (!db) { mem.nights.set(night.id, structuredClone(night)); return; }
  await tx(db, 'nights', 'readwrite', (s) => s.put(night));
}

export async function getNight(id) {
  const db = await open();
  if (!db) return mem.nights.get(id) ?? null;
  return tx(db, 'nights', 'readonly', (s) => reqP(s.get(id)));
}

export async function listNights() {
  const db = await open();
  const all = db ? await tx(db, 'nights', 'readonly', (s) => reqP(s.getAll())) : [...mem.nights.values()];
  return all.sort((a, b) => b.start - a.start);
}

export async function deleteNight(id) {
  const db = await open();
  if (!db) {
    mem.nights.delete(id);
    for (const [k, c] of mem.clips) if (c.nightId === id) mem.clips.delete(k);
    return;
  }
  const clipIds = await tx(db, 'clips', 'readonly', (s) => reqP(s.index('nightId').getAllKeys(id)));
  await tx(db, 'clips', 'readwrite', (s) => { for (const k of clipIds) s.delete(k); });
  await tx(db, 'nights', 'readwrite', (s) => s.delete(id));
}

export async function putClip(clip) {
  const db = await open();
  if (!db) { mem.clips.set(clip.id, clip); return; }
  await tx(db, 'clips', 'readwrite', (s) => s.put(clip));
}

export async function listClips(nightId) {
  const db = await open();
  const all = db
    ? await tx(db, 'clips', 'readonly', (s) => reqP(s.index('nightId').getAll(nightId)))
    : [...mem.clips.values()].filter((c) => c.nightId === nightId);
  return all.sort((a, b) => a.t0 - b.t0);
}

export async function clearAll() {
  const db = await open();
  if (!db) { mem.nights.clear(); mem.clips.clear(); return; }
  await tx(db, 'clips', 'readwrite', (s) => s.clear());
  await tx(db, 'nights', 'readwrite', (s) => s.clear());
}

// 작은 설정값(마지막 탭, 건강 체크 답변)은 localStorage
export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem('jamsori.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function savePref(key, value) {
  try { localStorage.setItem('jamsori.' + key, JSON.stringify(value)); } catch { /* 저장 못 해도 동작엔 지장 없음 */ }
}

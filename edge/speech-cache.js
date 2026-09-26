// Gemini's readings kept in the browser (IndexedDB), found by what was said and how, so hearing one again costs
// nothing: the same read and write as the local server's disk cache. Each reading's size and last use are kept
// apart from its audio, so the oldest can be let go, once the whole passes the cap, without reading any audio.
const CAP = 150 * 1024 * 1024;

export function speechCache(cap = CAP) {
  let opened = null;
  const db = () => (opened ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('yiju-speech', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pcm');
      request.result.createObjectStore('sizes').createIndex('at', 'at');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
  async function run(stores, mode, work) {
    const t = (await db()).transaction(stores, mode);
    let result;
    work(t, value => { result = value; });
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  return {
    async read(name) {
      const bytes = await run(['pcm'], 'readonly', (t, done) => { const r = t.objectStore('pcm').get(name); r.onsuccess = () => done(r.result || null); });
      if (bytes) void run(['sizes'], 'readwrite', t => { t.objectStore('sizes').put({ size: bytes.length, at: Date.now() }, name); }).catch(() => {});
      return bytes;
    },
    async write(name, bytes) {
      await run(['pcm', 'sizes'], 'readwrite', t => {
        t.objectStore('pcm').put(bytes, name);
        t.objectStore('sizes').put({ size: bytes.length, at: Date.now() }, name);
      });
      // Oldest first, down to four fifths of the cap.
      await run(['pcm', 'sizes'], 'readwrite', t => {
        const sizes = t.objectStore('sizes'), all = [];
        let total = 0;
        const cursor = sizes.index('at').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) { all.push([c.primaryKey, c.value.size]); total += c.value.size; c.continue(); return; }
          for (const [key, size] of all) {
            if (total <= cap * 0.8) break;
            t.objectStore('pcm').delete(key); sizes.delete(key); total -= size;
          }
        };
      });
    },
  };
}

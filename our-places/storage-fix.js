(() => {
  function b64urlEncode(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  }
  function b64urlDecode(value) {
    const normalized = value.replaceAll('-','+').replaceAll('_','/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const bin = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
  }

  encodeRecord = function(record) {
    const lat = Array.isArray(record.g) ? String(record.g[0]) : '';
    const lon = Array.isArray(record.g) ? String(record.g[1]) : '';
    return ['v3', record.i, b64urlEncode(record.n), record.d || '', record.m ? 1 : 0, record.v || 'B', record.t || Date.now(), record.x ? 1 : 0, lat, lon].join('~');
  };

  const previousDecode = decodeRecord;
  decodeRecord = function(raw) {
    if (!raw) return null;
    try {
      if (raw.startsWith('v3~')) {
        const parts = raw.split('~');
        if (parts.length < 10) return null;
        const lat = Number(parts[8]);
        const lon = Number(parts[9]);
        return {
          i: parts[1],
          n: b64urlDecode(parts[2]),
          d: parts[3],
          m: Number(parts[4]) ? 1 : 0,
          v: parts[5] || 'B',
          t: Number(parts[6]) || Date.now(),
          x: Number(parts[7]) ? 1 : 0,
          ...(Number.isFinite(lat) && Number.isFinite(lon) ? { g: [lat, lon] } : {})
        };
      }
      return previousDecode(raw);
    } catch (err) {
      console.warn('Record v3 non leggibile', err);
      return previousDecode(raw);
    }
  };
})();

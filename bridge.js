/* ============================================================
   Llvall native bridge (Capacitor Android only)
   ------------------------------------------------------------
   Cara kerja (bayangan / shadow):
   - Elemen audio web (SX) tetap diputar seperti biasa TAPI
     DIBISUKAN (muted). Ia yang menggerakkan seluruh logika
     aplikasi: UI, antrean, serah-terima antar-elemen, lirik,
     Media Session web, dsb. — persis seperti versi web.
   - Pemutar NATIVE (plugin NativeAudio) memutar URL stream yang
     SAMA secara nyaring. Ia tidak dijeda otomatis saat Activity
     dijeda (backgroundPlayback:true), dan plugin MediaSession
     menjalankan foreground service sungguhan (mediaPlayback)
     selama putar aktif, sehingga Android/MIUI tidak bisa
     mematikan proses saat aplikasi di-swipe dari recent apps —
     persis arsitektur MusicService-nya Mochy.
   - Media Session native (lock screen / notification shade)
     mencerminkan Media Session web: cover, judul, artis,
     putar/jeda, sebelumnya/berikutnya, geser posisi.
   Di browser/PWA seluruh blok ini tidak aktif (no-op).
   ============================================================ */
(function () {
  var Cap = window.Capacitor;
  if (!Cap || !Cap.Plugins || !Cap.Plugins.NativeAudio || !Cap.Plugins.MediaSession) return;
  var NA = Cap.Plugins.NativeAudio;
  var MS = Cap.Plugins.MediaSession;
  function noop() {}
  function dlog(msg) { try { if (typeof diagLog === 'function') diagLog('[native] ' + msg); } catch (e) {} }

  function whenReady(cb) {
    var n = 0;
    (function tick() {
      n++;
      try {
        if (typeof loadStreamTrack === 'function' && typeof S === 'object' && document.getElementById('streamAudio') && typeof togglePlay === 'function' && typeof nextTrack === 'function') { cb(); return; }
      } catch (e) {}
      if (n < 150) setTimeout(tick, 200);
    })();
  }
  whenReady(init);

  function init() {
    var ASSET = 'llvall-current';
    var curUrl = null, curAssetId = null, curTrackId = null;
    var nativeActive = false, nativePendingUrl = null, nativePendingAt = 0;
    var lastVol = null, lastRate = null, lastMetaKey = null;

    /* ---- 1. konfigurasi audio native ----
       backgroundPlayback:true -> plugin melewati jeda otomatis saat
       Activity dijeda (handleOnPause). showNotification:false ->
       notifikasi lock-screen dipegang plugin MediaSession saja
       (satu notifikasi, sekaligus foreground service-nya).
       focus:true -> minta fokus audio (ducking). */
    try { NA.configure({ backgroundPlayback: true, showNotification: false, focus: true, progressInterval: 0.5 }).catch(noop); } catch (e) {}

    /* ---- adopsi pemutar yang sudah berjalan dari Activity lama ----
       (aplikasi dibuka lagi selagi lagu masih bunyi di latar). */
    try {
      NA.getPlaybackState().then(function (st) {
        if (st && st.state === 'playing' && st.assetId) {
          curAssetId = st.assetId; nativeActive = true;
          dlog('mengadopsi pemutar native yang sedang bunyi: ' + st.assetId);
          pushState();
        }
      }).catch(noop);
    } catch (e) {}

    /* ---- 2. aksi lock-screen / notifikasi -> fungsi aplikasi ---- */
    try {
      MS.setActionHandler({ action: 'play' }, function () {
        try {
          if (typeof S !== 'undefined' && S.currentTrack) togglePlay(true);
          else if (nativeActive && curAssetId) { NA.resume({ assetId: curAssetId }).catch(noop); pushState(); }
        } catch (e) {}
      });
      MS.setActionHandler({ action: 'pause' }, function () {
        try {
          if (typeof S !== 'undefined' && S.currentTrack) togglePlay(false);
          else if (nativeActive && curAssetId) { NA.pause({ assetId: curAssetId }).catch(noop); pushState(); }
        } catch (e) {}
      });
      MS.setActionHandler({ action: 'previoustrack' }, function () { try { if (typeof S !== 'undefined' && S.currentTrack) prevTrack(); } catch (e) {} });
      MS.setActionHandler({ action: 'nexttrack' }, function () { try { if (typeof S !== 'undefined' && S.currentTrack) nextTrack(false); } catch (e) {} });
      MS.setActionHandler({ action: 'seekto' }, function (d) { try { if (d && typeof d.seekTime === 'number') engSeek(d.seekTime); } catch (e) {} });
    } catch (e) {}

    /* ---- helper ---- */
    function vol01() {
      try { var b = document.getElementById('volBar'); if (b) return Math.max(0, Math.min(1, (parseInt(b.value, 10) || 85) / 100)); } catch (e) {}
      try { if (typeof SA !== 'undefined' && SA) return SA.volume || 0.85; } catch (e) {}
      return 0.85;
    }
    function rate01() {
      try { var b = document.getElementById('speedRange'); if (b) return parseFloat(b.value) || 1; } catch (e) {}
      return 1;
    }
    function trackInfo(t) {
      t = t || (typeof S !== 'undefined' ? S.currentTrack : null);
      if (!t) return null;
      var art = '';
      try { art = t.artworkBig || t.artwork || (typeof artSrc === 'function' ? artSrc(t, true) : '') || ''; } catch (e) {}
      return { title: t.title || '', artist: t.artist || '', album: 'Llvall', artwork: art, id: t.id };
    }
    function pushMeta(t) {
      var info = trackInfo(t); if (!info) return;
      var key = info.id + '|' + info.title + '|' + info.artist;
      if (key === lastMetaKey) return;
      lastMetaKey = key;
      try {
        MS.setMetadata({ title: info.title, artist: info.artist, album: info.album, artwork: info.artwork ? [{ src: info.artwork, sizes: '512x512', type: 'image/png' }] : [] }).catch(noop);
      } catch (e) {}
    }
    function pushState() {
      try {
        var playing = !!(typeof S !== 'undefined' && S.playing);
        MS.setPlaybackState({ playbackState: playing ? 'playing' : 'paused' }).catch(noop);
        var el = null; try { el = SX; } catch (e) {}
        var d = 0, p = 0;
        if (el) { d = el.duration || 0; p = el.currentTime || 0; }
        if (isFinite(d) && d > 0) MS.setPositionState({ duration: d, position: Math.min(Math.max(0, p), d), playbackRate: rate01() }).catch(noop);
      } catch (e) {}
    }

    /* ---- putar / jeda native ---- */
    function nativePlay(url, t) {
      if (!url) return;
      var now = Date.now();
      if (url === curUrl && curAssetId && (nativeActive || (nativePendingUrl === url && now - nativePendingAt < 5000))) return; // sudah bunyi / sedang mulai
      if (url === curUrl && curAssetId) {
        /* Lagu sama, pemutar native berhenti/selesai -> mulai lagi dari
           posisi elemen web (kasus ulang-satu-lagu & lanjut sesudah jeda). */
        var pos = 0; try { pos = SX ? (SX.currentTime || 0) : 0; } catch (e) {}
        var aid = curAssetId;
        nativePendingUrl = url; nativePendingAt = now;
        var act = nativeActive
          ? NA.resume({ assetId: aid })
          : NA.setCurrentTime({ assetId: aid, time: pos }).catch(noop).then(function () { return NA.play({ assetId: aid }); });
        act.then(function () { nativeActive = true; nativePendingUrl = null; pushMeta(t); pushState(); })
           .catch(function () { nativeActive = false; nativePendingUrl = null; });
        return;
      }
      var prev = curAssetId;
      curUrl = url; curAssetId = ASSET; curTrackId = t ? t.id : null;
      nativePendingUrl = url; nativePendingAt = now;
      /* Mulai foreground service SEGERA (sebelum preload selesai) supaya
         proses terlindungi kalau pengguna langsung meninggalkan aplikasi. */
      try { pushMeta(t); MS.setPlaybackState({ playbackState: 'playing' }).catch(noop); } catch (e) {}
      var p = prev ? NA.unload({ assetId: prev }).catch(noop) : Promise.resolve();
      p.then(function () { return NA.preload({ assetId: ASSET, assetPath: url, isUrl: true }); })
        .then(function () { var v = vol01(); if (v !== lastVol) { lastVol = v; return NA.setVolume({ assetId: ASSET, volume: v }); } })
        .then(function () { var r = rate01(); if (r && r !== lastRate) { lastRate = r; return NA.setRate({ assetId: ASSET, rate: r }); } })
        .then(function () { return NA.play({ assetId: ASSET }); })
        .then(function () {
          nativeActive = true; nativePendingUrl = null;
          pushMeta(t); pushState();
          dlog('native mulai');
        })
        .catch(function (err) { nativeActive = false; nativePendingUrl = null; dlog('native gagal: ' + (err && err.message ? err.message : err)); });
    }
    function nativePause() {
      nativePendingUrl = null;
      if (curAssetId) { try { NA.pause({ assetId: curAssetId }).catch(noop); } catch (e) {} }
      nativeActive = false;
      pushState();
    }
    function nativeStop() {
      nativePendingUrl = null;
      if (curAssetId) { try { NA.stop({ assetId: curAssetId }).catch(noop); NA.unload({ assetId: curAssetId }).catch(noop); } catch (e) {} }
      nativeActive = false; curUrl = null; curAssetId = null; curTrackId = null;
      try { MS.setPlaybackState({ playbackState: 'paused' }).catch(noop); } catch (e) {}
    }

    /* ---- 3. kait: setiap kandidat stream yang dicoba aplikasi ---- */
    if (typeof tryStreamCandidate === 'function') {
      var _tryStream = tryStreamCandidate;
      tryStreamCandidate = function (seq, t, isRetry) {
        var r = _tryStream.apply(null, arguments);
        try {
          if (typeof S === 'undefined' || !S.intentPlay) return r;
          if (typeof engine !== 'undefined' && engine !== 'stream') return r;
          var url = (typeof candList !== 'undefined' && candList && typeof candIdx === 'number') ? candList[candIdx] : null;
          if (url) nativePlay(url, t);
        } catch (e) {}
        return r;
      };
    }
    /* Mesin cadangan YouTube (iframe) & berkas lokal tidak memakai
       pemutar native -> matikan native supaya tidak bunyi ganda. */
    if (typeof startYtFallback === 'function') {
      var _ytFb = startYtFallback;
      startYtFallback = function (t) {
        var r = _ytFb.apply(null, arguments);
        try { if (r) nativeStop(); } catch (e) {}
        return r;
      };
    }

    /* ---- 4. bisukan elemen web + cerminkan putar/jeda ----
       (elemen web tetap jalan supaya logika aplikasi tidak berubah). */
    try { if (typeof SA !== 'undefined' && SA) SA.muted = true; if (typeof SB !== 'undefined' && SB) SB.muted = true; } catch (e) {}
    [ (typeof SA !== 'undefined' ? SA : null), (typeof SB !== 'undefined' ? SB : null) ].forEach(function (el) {
      if (!el) return;
      el.addEventListener('play', function () {
        try {
          if (typeof engine !== 'undefined' && engine !== 'stream') return;
          if (el !== SX) return;
          var url = el.getAttribute('src') || el.src || '';
          if (!url) return;
          nativePlay(url, typeof S !== 'undefined' ? S.currentTrack : null);
        } catch (e) {}
      });
      el.addEventListener('pause', function () {
        try {
          if (typeof engine !== 'undefined' && engine !== 'stream') return;
          if (el !== SX) return;
          if (typeof S !== 'undefined' && S.intentPlay && S.loading) return; // jeda transisi kandidat: abaikan
          nativePause();
        } catch (e) {}
      });
    });

    /* ---- 5. kejadian native ---- */
    try {
      NA.addListener('complete', function () {
        try {
          if (typeof S === 'undefined' || !S.currentTrack) return;
          if (S.repeat === 2) return; // ulang-satu-lagu: aplikasi yang mengulang
          if (curTrackId != null && S.currentTrack.id !== curTrackId) return; // aplikasi sudah pindah duluan
          if (!S.playing) return;
          nativeActive = false;
          nextTrack(true);
        } catch (e) {}
      });
      NA.addListener('progress', function (ev) {
        try {
          if (ev && ev.assetId === curAssetId && isFinite(ev.duration) && ev.duration > 0) {
            MS.setPositionState({ duration: ev.duration, position: Math.min(Math.max(0, ev.position || 0), ev.duration), playbackRate: rate01() }).catch(noop);
          }
        } catch (e) {}
      });
    } catch (e) {}

    /* ---- 6. geser / volume / kecepatan ---- */
    if (typeof engSeek === 'function') {
      var _seek = engSeek;
      engSeek = function (sec) {
        var r = _seek.apply(null, arguments);
        try { if (curAssetId && typeof engine !== 'undefined' && engine === 'stream') NA.setCurrentTime({ assetId: curAssetId, time: sec }).catch(noop); } catch (e) {}
        return r;
      };
    }
    if (typeof setSpeed === 'function') {
      var _spd = setSpeed;
      setSpeed = function (v) {
        var r = _spd.apply(null, arguments);
        try { if (curAssetId) { lastRate = v; NA.setRate({ assetId: curAssetId, rate: v }).catch(noop); } } catch (e) {}
        return r;
      };
    }

    /* ---- 7. keadaan media native mengikuti keadaan aplikasi ---- */
    if (typeof syncMediaState === 'function') {
      var _sms = syncMediaState;
      syncMediaState = function () {
        var r = _sms.apply(null, arguments);
        try { pushState(); } catch (e) {}
        return r;
      };
    }

    /* ---- 8. penjaga berkala (1 dtk) ---- */
    setInterval(function () {
      try {
        if (typeof SA !== 'undefined' && SA && !SA.muted) SA.muted = true;
        if (typeof SB !== 'undefined' && SB && !SB.muted) SB.muted = true;
        if (typeof engine !== 'undefined' && engine !== 'stream') { if (nativeActive || curAssetId) nativeStop(); return; }
        if (typeof S === 'undefined') return;
        if (S.currentTrack) pushMeta(S.currentTrack);
        var v = vol01();
        if (curAssetId && v !== lastVol) { lastVol = v; NA.setVolume({ assetId: curAssetId, volume: v }).catch(noop); }
        var rt = rate01();
        if (curAssetId && rt && rt !== lastRate) { lastRate = rt; NA.setRate({ assetId: curAssetId, rate: rt }).catch(noop); }
        /* Jaring pengaman: keadaan native mengikuti niat aplikasi. */
        if (S.playing && !nativeActive && !nativePendingUrl && typeof SX !== 'undefined' && SX && SX.getAttribute && SX.getAttribute('src')) {
          nativePlay(SX.getAttribute('src') || SX.src, S.currentTrack);
        } else if (!S.playing && !S.loading && nativeActive) {
          nativePause();
        }
      } catch (e) {}
    }, 1000);

    dlog('bridge siap');
  }
})();

/* ECDB — عميل خفيف لـ Supabase (دخول + قراءة + حفظ) بدون مكتبات خارجية.
   يُفعَّل فقط إذا عُرّف window.EC_CONFIG = { supabaseUrl, anonKey } (ملف config.js). */
(function () {
  var cfg = window.EC_CONFIG;
  if (!cfg || !cfg.supabaseUrl || !cfg.anonKey) { window.ECDB = null; return; }
  var URL_ = String(cfg.supabaseUrl).replace(/\/+$/, ''), KEY = cfg.anonKey, SK = 'ec_sb_session_v1';
  var sess = null;
  try { sess = JSON.parse(localStorage.getItem(SK) || 'null'); } catch (e) { sess = null; }
  function keep(s) { sess = s; try { if (s) localStorage.setItem(SK, JSON.stringify(s)); else localStorage.removeItem(SK); } catch (e) {} }
  function mkSession(j) { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, user: j.user }; }

  var AR = [
    [/invalid login credentials/i, 'البريد أو كلمة المرور غير صحيحة.'],
    [/already registered|already been registered/i, 'هذا البريد مسجّل مسبقًا — جرّب «دخول».'],
    [/email not confirmed/i, 'لم يُفعَّل البريد بعد — افتح رسالة التفعيل المرسلة إليك ثم ادخل.'],
    [/at least (\d+) char/i, 'كلمة المرور قصيرة — استخدم ٨ أحرف على الأقل.'],
    [/valid email|invalid email|unable to validate email/i, 'صيغة البريد غير صحيحة.'],
    [/rate limit|too many|over_email_send_rate_limit/i, 'محاولات كثيرة — انتظر دقيقة ثم أعد المحاولة.'],
    [/signups? (not allowed|disabled)/i, 'التسجيل مغلق حاليًا — تواصل مع قيادة النادي.']
  ];
  function arMsg(m) { m = String(m || ''); for (var i = 0; i < AR.length; i++) if (AR[i][0].test(m)) return AR[i][1]; return m || 'تعذّر إكمال الطلب.'; }
  function failure(status, j, fallback) {
    var e = new Error(arMsg((j && (j.msg || j.message || j.error_description || j.error)) || fallback));
    e.status = status; e.code = j && (j.code || j.error_code) ? String(j.code || j.error_code) : ''; e.raw = j; return e;
  }

  var refreshing = null;
  function refresh() {
    if (!sess || !sess.refresh_token) return Promise.reject(new Error('NO_SESSION'));
    if (refreshing) return refreshing;
    refreshing = fetch(URL_ + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: sess.refresh_token }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.access_token) { keep(null); throw failure(r.status, j, 'انتهت الجلسة'); } keep(mkSession(j)); return sess; }); })
      .then(function (s) { refreshing = null; return s; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  function fresh() { if (sess && sess.expires_at - Date.now() < 60000) return refresh(); return Promise.resolve(sess); }

  function rest(method, path, body, prefer) {
    function go() {
      var h = { apikey: KEY, 'Content-Type': 'application/json' };
      if (sess) h.Authorization = 'Bearer ' + sess.access_token;
      if (prefer) h.Prefer = prefer;
      return fetch(URL_ + '/rest/v1/' + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    }
    return fresh().then(go).then(function (r) {
      if (r.status === 401 && sess) return refresh().then(go);
      return r;
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!r.ok) throw failure(r.status, j, 'تعذّر الاتصال بقاعدة البيانات (' + r.status + ')');
        return j;
      });
    });
  }
  function selectAll(table, order) {
    var out = [], page = 1000;
    function next(off) {
      return rest('GET', table + '?select=*' + (order ? '&order=' + order : '') + '&limit=' + page + '&offset=' + off).then(function (rows) {
        rows = rows || []; out = out.concat(rows);
        return rows.length === page ? next(off + page) : out;
      });
    }
    return next(0);
  }

  // ---------- التحويل بين صفوف القاعدة وحالة التطبيق ----------
  var OW = { name: 'name', project: 'project', channel: 'channel', person: 'person', owner: 'owner', status: 'status', sector: 'sector', contact: 'contact', title: 'title', email: 'email', notes: 'notes', createdAt: 'created_at', closedAt: 'closed_at' };
  function orgRow(o) {
    var E = window.ECEngine, r = { name_key: E.norm(o.name) };
    Object.keys(OW).forEach(function (k) { r[OW[k]] = o[k] === undefined ? null : o[k]; });
    r.id = o.id; r.sector = r.sector || ''; r.contact = r.contact || ''; r.title = r.title || ''; r.email = r.email || ''; r.notes = r.notes || ''; r.person = r.person || '';
    return r;
  }
  function orgFrom(r) { var o = { id: r.id }; Object.keys(OW).forEach(function (k) { o[k] = r[OW[k]]; }); o.closedAt = r.closed_at == null ? null : Number(r.closed_at); o.createdAt = Number(r.created_at); return o; }
  function actFrom(r) { return { id: r.id, org: r.org, by: r.by, at: Number(r.at), type: r.type, note: r.note || '', meta: r.meta || undefined }; }
  function notifFrom(r) { return { id: r.id, kind: r.kind, to: r.to_user, from: r.from_user, about: r.about || undefined, org: r.org, cycle: Number(r.cycle), scheduledFor: Number(r.scheduled_for), deliveredAt: Number(r.delivered_at), readAt: r.read_at == null ? null : Number(r.read_at), text: r.text || '' }; }
  function userFrom(r) { return { id: r.id, name: r.name || r.email || '—', role: r.role, team: r.team, title: r.title || 'عضو', email: r.email }; }
  function byId(list) { var m = {}; list.forEach(function (x) { m[x.id] = x; }); return m; }

  var chain = Promise.resolve(), pending = 0;
  function enqueue(fn) { pending++; var p = chain.then(fn); chain = p.then(function () { pending--; }, function () { pending--; }); return p; }

  window.ECDB = {
    pending: function () { return pending; },
    session: function () { return sess; },
    restore: function () { return sess ? fresh().then(function () { return sess; }, function () { return null; }) : Promise.resolve(null); },
    signIn: function (email, password) {
      return fetch(URL_ + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.access_token) throw failure(r.status, j, 'تعذّر تسجيل الدخول'); keep(mkSession(j)); return sess; }); });
    },
    signUp: function (email, password, name, team) {
      return fetch(URL_ + '/auth/v1/signup', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password, data: { name: name, team: team } }) })
        .then(function (r) { return r.json().then(function (j) {
          if (!r.ok) throw failure(r.status, j, 'تعذّر إنشاء الحساب');
          if (j.access_token) { keep(mkSession(j)); return { session: sess }; }
          return { needsConfirm: true };
        }); });
    },
    signOut: function () {
      var t = sess && sess.access_token; keep(null);
      if (t) return fetch(URL_ + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t } }).catch(function () {});
      return Promise.resolve();
    },
    runReminders: function () { return rest('POST', 'rpc/ec_run_reminders', {}).catch(function () { return null; }); },
    load: function () {
      return Promise.all([selectAll('profiles', 'created_at.asc,id.asc'), selectAll('orgs', 'created_at.desc,id.asc'), selectAll('acts', 'at.desc,id.asc'), selectAll('notifs', 'delivered_at.desc,id.asc')]).then(function (a) {
        return { users: a[0].map(userFrom), orgs: a[1].map(orgFrom), acts: a[2].map(actFrom), notifs: a[3].map(notifFrom), seq: 1000 };
      });
    },
    // يحفظ الفروقات بين حالتين (بالترتيب: الجهات ← الأنشطة ← الإشعارات). يرمي خطأ عربيًا عند الرفض.
    save: function (oldS, newS) {
      var om = byId(oldS.orgs), am = byId(oldS.acts), nm = byId(oldS.notifs), ops = [];
      var newOrgs = newS.orgs.filter(function (o) { return !om[o.id]; });
      if (newOrgs.length) ops.push(function () { return rest('POST', 'orgs', newOrgs.map(orgRow), 'return=minimal'); });
      newS.orgs.forEach(function (o) {
        var p = om[o.id]; if (!p || p === o) return;
        var patch = {}; Object.keys(OW).forEach(function (k) { if (o[k] !== p[k]) patch[OW[k]] = o[k] === undefined ? null : o[k]; });
        if (patch.name !== undefined) patch.name_key = window.ECEngine.norm(o.name);
        if (!Object.keys(patch).length) return;
        ops.push(function () { return rest('PATCH', 'orgs?id=eq.' + encodeURIComponent(o.id), patch, 'return=representation').then(function (rows) { if (!rows || !rows.length) { var e = new Error('ليست لديك صلاحية تعديل هذه الجهة.'); e.code = 'RLS'; throw e; } }); });
      });
      var newActs = newS.acts.filter(function (a) { return !am[a.id]; });
      if (newActs.length) ops.push(function () { return rest('POST', 'acts', newActs.map(function (a) { return { id: a.id, org: a.org, by: a.by, at: a.at, type: a.type, note: a.note || '', meta: a.meta || null }; }), 'return=minimal'); });
      newS.acts.forEach(function (a) { var p = am[a.id]; if (p && p !== a && p.note !== a.note) ops.push(function () { return rest('PATCH', 'acts?id=eq.' + encodeURIComponent(a.id), { note: a.note || '' }, 'return=representation').then(function (rows) { if (!rows || !rows.length) { var e = new Error('لا يمكن تعديل هذه الملاحظة.'); e.code = 'RLS'; throw e; } }); }); });
      var newNotifs = newS.notifs.filter(function (n) { return !nm[n.id]; });
      if (newNotifs.length) ops.push(function () { return rest('POST', 'notifs', newNotifs.map(function (n) { return { id: n.id, kind: n.kind, to_user: n.to, from_user: n.from, about: n.about || null, org: n.org, cycle: n.cycle, scheduled_for: n.scheduledFor, delivered_at: n.deliveredAt, read_at: null, text: n.text || '' }; }), 'return=minimal'); });
      newS.notifs.forEach(function (n) { var p = nm[n.id]; if (p && p !== n && p.readAt !== n.readAt) ops.push(function () { return rest('PATCH', 'notifs?id=eq.' + encodeURIComponent(n.id), { read_at: n.readAt }, 'return=minimal'); }); });
      if (!ops.length) return Promise.resolve();
      return enqueue(function () { return ops.reduce(function (p, f) { return p.then(f); }, Promise.resolve()); }).catch(function (e) {
        if (e && e.code === '23505') e.message = 'سبقك عضو آخر بتسجيل هذه الجهة وهي قيد التواصل — حدّثتُ القائمة.';
        else if (e && (e.code === '42501' || e.code === 'RLS' || e.status === 403)) e.message = e.message && e.code === 'RLS' ? e.message : 'ليست لديك صلاحية هذه العملية.';
        throw e;
      });
    }
  };
})();

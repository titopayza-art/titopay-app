/**
 * Ligcabho admin portal.
 * Hash-routed views over the PHP API in /api. No framework, no build step.
 */
(function () {
  'use strict';

  var API = '../api/';
  var state = { user: null, rows: {}, stats: null };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast is-on' + (kind ? ' toast--' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 3400);
  }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { showLogin(); throw new Error(j.error || 'Please sign in again.'); }
        if (!r.ok || j.ok === false) throw new Error(j.error || 'Request failed (' + r.status + ')');
        return j;
      });
    });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) +
           ' · ' + d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  function badge(v) {
    return '<span class="badge badge--' + esc(v || 'new') + '">' + esc(String(v || '—').replace(/_/g, ' ')) + '</span>';
  }
  function isOwner() { return state.user && state.user.role === 'owner'; }
  function canManage() { return state.user && (state.user.role === 'owner' || state.user.role === 'manager'); }
  function waLink(phone) {
    var n = String(phone || '').replace(/\D/g, '').replace(/^0/, '27');
    return n ? 'https://wa.me/' + n : null;
  }

  /* -------------------------------- auth -------------------------------- */
  function showLogin() {
    $('#shell').hidden = true;
    $('#change-pass').hidden = true;
    $('#login').hidden = false;
    state.user = null;
  }

  function showShell() {
    $('#login').hidden = true;
    $('#change-pass').hidden = true;
    $('#shell').hidden = false;
    var name = state.user.name || 'Ligcabho';
    $('#who-name').textContent = name;
    $('#who-role').textContent = state.user.role;
    $('#who-initials').textContent = name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    $$('[data-owner]').forEach(function (el) { el.hidden = !isOwner(); });
    route();
  }

  function afterAuth(user) {
    state.user = user;
    if (Number(user.must_change_password) === 1) {
      $('#login').hidden = true;
      $('#shell').hidden = true;
      $('#change-pass').hidden = false;
      setTimeout(function () { $('#cp-current').focus(); }, 60);
      return;
    }
    showShell();
  }

  $('#login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('#login-msg'), btn = $('#login-btn');
    msg.hidden = true;
    btn.disabled = true; btn.textContent = 'Signing in…';
    api('auth/login', { method: 'POST', body: { email: $('#li-email').value.trim(), password: $('#li-pass').value } })
      .then(function (d) { $('#li-pass').value = ''; afterAuth(d.user); })
      .catch(function (err) { msg.textContent = err.message; msg.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
  });

  $('#cp-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('#cp-msg');
    msg.hidden = true;
    if ($('#cp-new').value !== $('#cp-confirm').value) {
      msg.textContent = 'The two new passwords do not match.'; msg.hidden = false; return;
    }
    api('auth/password', { method: 'POST', body: { current_password: $('#cp-current').value, new_password: $('#cp-new').value } })
      .then(function () {
        state.user.must_change_password = 0;
        $('#cp-form').reset();
        toast('Password updated.', 'ok');
        showShell();
      })
      .catch(function (err) { msg.textContent = err.message; msg.hidden = false; });
  });

  $('#sign-out').addEventListener('click', function () {
    api('auth/logout', { method: 'POST' }).then(showLogin).catch(showLogin);
  });
  $('#side-toggle').addEventListener('click', function () { $('#side').classList.toggle('is-open'); });
  $('#detail-close').addEventListener('click', function () { $('#detail').hidden = true; });

  /* ------------------------------- exports ------------------------------- */
  function exportXlsx(rows, sheet, file) {
    if (!window.XLSX) return toast('The spreadsheet library did not load.', 'err');
    if (!rows.length) return toast('Nothing to export yet.', 'err');
    var ws = XLSX.utils.json_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    XLSX.writeFile(wb, 'ligcabho-' + file + '-' + stamp() + '.xlsx');
  }

  function exportPdf(title, head, body, orientation) {
    var Ctor = window.jspdf && window.jspdf.jsPDF;
    if (!Ctor) return toast('The PDF library did not load.', 'err');
    if (!body.length) return toast('Nothing to export yet.', 'err');
    var doc = new Ctor({ orientation: orientation || 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(15);
    doc.text("Ligcabho Le'Africa Residences", 40, 40);
    doc.setFontSize(11);
    doc.setTextColor(120);
    doc.text(title + ' · ' + new Date().toLocaleDateString('en-ZA'), 40, 58);
    doc.autoTable({
      head: [head], body: body, startY: 74, styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [34, 28, 24] }, alternateRowStyles: { fillColor: [247, 244, 239] }
    });
    doc.save('ligcabho-' + title.toLowerCase().replace(/\s+/g, '-') + '-' + stamp() + '.pdf');
  }

  function exportCsv(rows, file) {
    if (!rows.length) return toast('Nothing to export yet.', 'err');
    var cols = Object.keys(rows[0]);
    var esc2 = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var csv = '﻿' + cols.join(',') + '\n' +
      rows.map(function (r) { return cols.map(function (c) { return esc2(r[c]); }).join(','); }).join('\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ligcabho-' + file + '-' + stamp() + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ------------------------------ record views --------------------------- */
  var VIEWS = {
    applications: {
      title: 'Applications', endpoint: 'applications', sheet: 'Applications',
      statuses: ['new', 'reviewing', 'accepted', 'waitlist', 'placed', 'rejected'],
      columns: [
        ['ref', 'Reference'],
        ['name', 'Applicant', function (r) { return esc(r.first_name + ' ' + r.last_name); }],
        ['institution', 'Institution'],
        ['residence', 'Residence', function (r) { return esc(r.residence || 'No preference'); }],
        ['funder', 'Funder'],
        ['source', 'Via', function (r) { return '<span class="badge">' + esc(r.source) + '</span>'; }],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Received', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [
        ['ref', 'Reference'], ['first_name', 'First name'], ['last_name', 'Last name'],
        ['id_number', 'ID number'], ['student_number', 'Student number'], ['gender', 'Gender'],
        ['phone', 'Phone'], ['email', 'Email'], ['level_of_study', 'Level of study'],
        ['institution', 'Institution'], ['funder', 'Funder'], ['year_applying', 'Year'],
        ['residence', 'Preferred residence'], ['room_type', 'Room type'], ['notes', 'Applicant notes'],
        ['source', 'Submitted via'], ['created_at', 'Received', fmtDate]
      ],
      file: 'pop_stored', fileLabel: 'proof of payment',
      lease: true
    },
    enquiries: {
      title: 'Enquiries', endpoint: 'enquiries', sheet: 'Enquiries',
      statuses: ['new', 'in_progress', 'answered', 'closed'],
      columns: [
        ['name', 'From'], ['email', 'Email'], ['phone', 'Phone'],
        ['residence', 'About', function (r) { return esc(r.residence || r.topic || 'General'); }],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Received', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['topic', 'Topic'],
               ['residence', 'Residence'], ['message', 'Message'], ['created_at', 'Received', fmtDate]]
    },
    maintenance: {
      title: 'Maintenance', endpoint: 'maintenance', sheet: 'Maintenance',
      statuses: ['logged', 'assigned', 'in_progress', 'resolved', 'closed'],
      columns: [
        ['ref', 'Reference'], ['residence', 'Residence'], ['room', 'Room'],
        ['category', 'Category'],
        ['urgency', 'Urgency', function (r) { return badge(r.urgency); }],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Logged', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [['ref', 'Reference'], ['residence', 'Residence'], ['room', 'Room'], ['name', 'Reported by'],
               ['phone', 'Phone'], ['email', 'Email'], ['category', 'Category'], ['urgency', 'Urgency'],
               ['description', 'Description'], ['created_at', 'Logged', fmtDate]]
    },
    orders: {
      title: 'LVL UP orders', endpoint: 'orders', sheet: 'Orders',
      statuses: ['new', 'paid', 'ready', 'collected', 'cancelled'],
      columns: [
        ['ref', 'Reference'], ['pack', 'Pack'], ['name', 'Student'], ['phone', 'Phone'],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Ordered', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [['ref', 'Reference'], ['pack', 'Pack'], ['name', 'Name'], ['email', 'Email'],
               ['phone', 'Phone'], ['residence', 'Residence'], ['created_at', 'Ordered', fmtDate]]
    },
    retentions: {
      title: 'Retention', endpoint: 'retentions', sheet: 'Retention',
      statuses: ['new', 'reviewing', 'confirmed', 'room_allocated', 'waitlisted', 'declined'],
      columns: [
        ['ref', 'Reference'],
        ['name', 'Student', function (r) { return esc(r.first_name + ' ' + r.last_name); }],
        ['current_residence', 'This year', function (r) {
          return esc(r.current_residence || '—') + (r.current_room ? '<br><span class="muted">Room ' +
            esc(r.current_room) + '</span>' : '');
        }],
        ['coming_back', 'Coming back', function (r) {
          var map = { yes: 'placed', no: 'rejected', undecided: 'waitlist' };
          var word = { yes: 'Yes', no: 'Leaving', undecided: 'Undecided' }[r.coming_back] || r.coming_back;
          return '<span class="badge badge--' + esc(map[r.coming_back] || 'new') + '">' + esc(word) + '</span>';
        }],
        ['room', 'Wants', function (r) {
          if (r.coming_back !== 'yes') return esc(r.leaving_reason || '—');
          var where = { yes: 'the same room', same_house: 'same house, new room', move: 'to move' }[r.same_room] || '';
          return esc([where, r.preferred_residence, r.room_type].filter(Boolean).join(' · ') || 'No preference');
        }],
        ['funder', 'Funder', function (r) {
          return esc(r.funder || '—') + (r.funding_confirmed === 'yes'
            ? ' <span class="badge badge--paid">confirmed</span>' : '');
        }],
        ['rating', 'Rated', function (r) { return r.rating ? stars(r.rating) : '—'; }],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Sent', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [
        ['ref', 'Reference'], ['first_name', 'First name'], ['last_name', 'Last name'],
        ['id_number', 'ID number'], ['student_number', 'Student number'], ['gender', 'Gender'],
        ['phone', 'Phone'], ['email', 'Email'],
        ['current_residence', 'Residence this year'], ['current_room', 'Room this year'],
        ['months_in_residence', 'Time in residence'], ['lease_end', 'Current lease ends'],
        ['account_up_to_date', 'Account up to date'],
        ['coming_back', 'Coming back'], ['leaving_reason', 'Reason for leaving'],
        ['year_applying', 'Year'], ['institution', 'Institution'], ['level_of_study', 'Level next year'],
        ['funder', 'Funder'], ['funding_confirmed', 'Funding confirmed'],
        ['same_room', 'Room request'], ['preferred_residence', 'Preferred residence'],
        ['room_type', 'Room type'], ['roommate', 'Wants to share with'], ['move_in_date', 'Move-in date'],
        ['rating', 'Rating of their stay'], ['recommend', 'Would recommend'],
        ['what_worked', 'What worked'], ['what_to_improve', 'What to improve'],
        ['outstanding_maintenance', 'Outstanding maintenance'], ['notes', 'Other notes'],
        ['signed_name', 'Signed'], ['created_at', 'Sent', fmtDate]
      ],
      lease: true
    },
    cancellations: {
      title: 'Cancellations', endpoint: 'cancellations', sheet: 'Cancellations',
      statuses: ['new', 'acknowledged', 'inspection', 'settled', 'declined'],
      columns: [
        ['ref', 'Reference'], ['name', 'Student'], ['residence', 'Residence'], ['room', 'Room'],
        ['vacate_date', 'Vacating'], ['reason', 'Reason'],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Given', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [['ref', 'Reference'], ['name', 'Student'], ['email', 'Email'], ['phone', 'Phone'],
               ['id_number', 'ID number'], ['student_number', 'Student number'], ['residence', 'Residence'],
               ['room', 'Room'], ['vacate_date', 'Vacate date'], ['reason', 'Reason'], ['detail', 'Detail'],
               ['forwarding_address', 'Forwarding address'], ['refund_account', 'Refund account'],
               ['created_at', 'Notice given', fmtDate]]
    },
    refunds: {
      title: 'Refunds', endpoint: 'refunds', sheet: 'Refunds',
      statuses: ['new', 'checking', 'approved', 'paid', 'declined'],
      columns: [
        ['ref', 'Reference'], ['name', 'Claimant'],
        ['claimant', 'Who', function (r) { return '<span class="badge">' + esc(r.claimant) + '</span>'; }],
        ['amount', 'Amount', function (r) { return 'R' + esc(r.amount || '0'); }],
        ['reason', 'Reason', function (r) { return esc(String(r.reason || '').slice(0, 42)); }],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Claimed', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [['ref', 'Reference'], ['claimant', 'Claimant type'], ['name', 'Name'], ['id_number', 'ID number'],
               ['email', 'Email'], ['phone', 'Phone'], ['residence', 'Residence'], ['room', 'Room'],
               ['application_ref', 'Application reference'], ['reason', 'Reason'], ['amount', 'Amount claimed'],
               ['paid_on', 'Date paid'], ['detail', 'What happened'], ['bank_name', 'Bank'],
               ['account_name', 'Account holder'], ['account_number', 'Account number'],
               ['branch_code', 'Branch code'], ['created_at', 'Claimed', fmtDate]],
      file: 'pop_stored', fileLabel: 'proof of payment'
    },
    staff: {
      title: 'Staff requests', endpoint: 'staff-requests', sheet: 'Staff requests',
      statuses: ['new', 'acknowledged', 'approved', 'declined', 'closed'],
      columns: [
        ['ref', 'Reference'], ['name', 'Staff member'], ['kind', 'Type'], ['role', 'Role'],
        ['residence', 'Based at'],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Sent', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [['ref', 'Reference'], ['kind', 'Type'], ['name', 'Staff member'], ['role', 'Role'],
               ['email', 'Email'], ['phone', 'Phone'], ['residence', 'Based at'], ['start_date', 'From'],
               ['end_date', 'To'], ['days', 'Days'], ['amount', 'Amount'], ['detail', 'Detail'],
               ['created_at', 'Sent', fmtDate]],
      file: 'document_stored', fileLabel: 'attachment'
    },
    supplies: {
      title: 'Supplies', endpoint: 'supplies', sheet: 'Supplies',
      statuses: ['new', 'ordered', 'delivered', 'cancelled'],
      columns: [
        ['ref', 'Reference'], ['residence', 'Residence'], ['name', 'Requested by'],
        ['needed_by', 'Needed by'],
        ['urgency', 'Urgency', function (r) { return badge(r.urgency); }],
        ['status', 'Status', function (r) { return badge(r.status); }],
        ['created_at', 'Sent', function (r) { return '<span class="nowrap">' + esc(fmtDay(r.created_at)) + '</span>'; }]
      ],
      detail: [['ref', 'Reference'], ['residence', 'Residence'], ['name', 'Requested by'], ['email', 'Email'],
               ['phone', 'Phone'], ['needed_by', 'Needed by'], ['urgency', 'Urgency'], ['items', 'Items'],
               ['notes', 'Notes'], ['created_at', 'Sent', fmtDate]]
    },
    subscribers: {
      title: 'Newsletter', endpoint: 'subscribers', sheet: 'Subscribers', statuses: [],
      columns: [['name', 'Name'], ['email', 'Email'],
                ['created_at', 'Subscribed', function (r) { return esc(fmtDay(r.created_at)); }]],
      detail: [['name', 'Name'], ['email', 'Email'], ['created_at', 'Subscribed', fmtDate]]
    }
  };

  function renderList(key) {
    var cfg = VIEWS[key];
    $('#view-title').textContent = cfg.title;

    var statusOpts = cfg.statuses.map(function (s) {
      return '<option value="' + s + '">' + esc(s.replace(/_/g, ' ')) + '</option>';
    }).join('');

    $('#view').innerHTML =
      '<div class="toolbar">' +
        '<input id="q" type="search" placeholder="Search…">' +
        (cfg.statuses.length ? '<select id="status"><option value="">All statuses</option>' + statusOpts + '</select>' : '') +
        '<span class="spacer"></span>' +
        '<button class="btn btn--ghost btn--sm" id="x-xlsx" type="button">Excel</button>' +
        '<button class="btn btn--ghost btn--sm" id="x-pdf" type="button">PDF</button>' +
        '<button class="btn btn--ghost btn--sm" id="x-csv" type="button">CSV</button>' +
      '</div><div class="tablewrap" id="table"></div>';

    var load = function () {
      var q = ($('#q') && $('#q').value.trim()) || '';
      var st = ($('#status') && $('#status').value) || '';
      var qs = [];
      if (q) qs.push('q=' + encodeURIComponent(q));
      if (st) qs.push('status=' + encodeURIComponent(st));
      $('#table').innerHTML = '<p class="empty">Loading…</p>';
      api(cfg.endpoint + (qs.length ? '?' + qs.join('&') : ''))
        .then(function (d) { state.rows[key] = d.items; paint(d.items); })
        .catch(function (e) { $('#table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
    };

    var paint = function (rows) {
      if (!rows.length) { $('#table').innerHTML = '<p class="empty">Nothing here yet.</p>'; return; }
      var head = cfg.columns.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('');
      var body = rows.map(function (r, i) {
        return '<tr data-i="' + i + '">' + cfg.columns.map(function (c) {
          return '<td>' + (c[2] ? c[2](r) : esc(r[c[0]] || '—')) + '</td>';
        }).join('') + '</tr>';
      }).join('');
      $('#table').innerHTML = '<table class="data"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
      $$('#table tbody tr').forEach(function (tr) {
        tr.addEventListener('click', function () { openDetail(key, rows[Number(tr.dataset.i)]); });
      });
    };

    if ($('#q')) {
      var t;
      $('#q').addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 250); });
    }
    if ($('#status')) $('#status').addEventListener('change', load);

    $('#x-xlsx').addEventListener('click', function () { exportXlsx(state.rows[key] || [], cfg.sheet, key); });
    $('#x-csv').addEventListener('click', function () { exportCsv(state.rows[key] || [], key); });
    $('#x-pdf').addEventListener('click', function () {
      var rows = state.rows[key] || [];
      exportPdf(cfg.title,
        cfg.columns.map(function (c) { return c[1]; }),
        rows.map(function (r) {
          return cfg.columns.map(function (c) {
            if (c[0] === 'name' && r.first_name) return r.first_name + ' ' + r.last_name;
            var v = r[c[0]];
            return c[0] === 'created_at' ? fmtDay(v) : String(v == null ? '' : v);
          });
        }));
    });

    load();
  }

  function openDetail(key, row) {
    var cfg = VIEWS[key];
    $('#detail-title').textContent = cfg.title.replace(/s$/, '') + ' detail';

    var dl = cfg.detail.map(function (f) {
      var v = f[2] ? f[2](row[f[0]]) : row[f[0]];
      return '<dt>' + esc(f[1]) + '</dt><dd>' + esc(v || '—') + '</dd>';
    }).join('');

    var doc = (cfg.file && row[cfg.file])
      ? '<p><a class="btn btn--ghost btn--sm" href="' + API + 'files/' + encodeURIComponent(row[cfg.file]) +
        '" target="_blank" rel="noopener">Open ' + esc(cfg.fileLabel || 'attachment') + '</a></p>' : '';

    var statusSel = cfg.statuses.length
      ? '<div class="field"><label for="d-status">Status</label><select id="d-status">' +
        cfg.statuses.map(function (s) {
          return '<option value="' + s + '"' + (row.status === s ? ' selected' : '') + '>' + esc(s.replace(/_/g, ' ')) + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field"><label for="d-notes">Internal notes</label><textarea id="d-notes">' +
        esc(row.admin_notes || '') + '</textarea></div>'
      : '';

    var wa = waLink(row.phone);
    $('#detail-body').innerHTML =
      '<dl>' + dl + '</dl>' + doc + statusSel +
      '<div class="actions">' +
        (cfg.statuses.length ? '<button class="btn btn--primary btn--sm" id="d-save" type="button">Save changes</button>' : '') +
        (cfg.lease && canManage() ? '<button class="btn btn--ghost btn--sm" id="d-lease" type="button">Create lease</button>' : '') +
        (row.email ? '<button class="btn btn--ghost btn--sm" id="d-mail" type="button">Send email</button>' : '') +
        (wa ? '<a class="btn btn--ghost btn--sm" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
        (canManage() ? '<button class="btn btn--danger btn--sm" id="d-del" type="button">Delete</button>' : '') +
      '</div>' +
      '<div id="d-mails"></div>';

    $('#detail').hidden = false;
    mailHistory('#d-mails', row.email || row.tenant_email || '', key, row.id);

    if ($('#d-save')) {
      $('#d-save').addEventListener('click', function () {
        api(cfg.endpoint + '/' + row.id, {
          method: 'PATCH', body: { status: $('#d-status').value, admin_notes: $('#d-notes').value }
        }).then(function () {
          toast('Saved.', 'ok');
          $('#detail').hidden = true;
          renderList(key);
          refreshCounts();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
    if ($('#d-mail')) {
      $('#d-mail').addEventListener('click', function () { compose({ row: row, kind: key }); });
    }
    if ($('#d-lease')) {
      $('#d-lease').addEventListener('click', function () { location.hash = '#/leases'; setTimeout(function () { newLease(row); }, 200); });
    }
    if ($('#d-del')) {
      $('#d-del').addEventListener('click', function () {
        if (!window.confirm('Delete this record permanently? This cannot be undone.')) return;
        api(cfg.endpoint + '/' + row.id, { method: 'DELETE' }).then(function () {
          toast('Deleted.', 'ok');
          $('#detail').hidden = true;
          renderList(key);
          refreshCounts();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
  }


  /* -------------------------------- today -------------------------------- */
  var KIND_ICON = {
    application: 'M4 3h10l4 4v14H4z', enquiry: 'M3 6h18v12H3z', maintenance: 'M14 6l4 4-8 8H6v-4z',
    cancellation: 'M4 4h12l4 4v12H4z', review: 'm12 4 2.4 5 5.6.7-4 3.9 1 5.4-5-2.7-5 2.7 1-5.4-4-3.9 5.6-.7z',
    lease: 'M5 3h9l5 5v13H5z', careers: 'M3 8h18v12H3z', order: 'M5 7h14l-1 13H6z',
    refund: 'M12 3v18M8 7h6a3 3 0 0 1 0 6H8m0 0h6', staff: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21v-1a6 6 0 0 1 16 0v1',
    supplies: 'M5 7h14l-1 13H6z M9 7V5a3 3 0 0 1 6 0v2',
    retention: 'M4 7h16v13H4z M9 3v4M15 3v4M8 13h8'
  };

  function ago(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    return fmtDay(iso);
  }

  function renderToday() {
    $('#view-title').textContent = 'Today';
    $('#view').innerHTML = '<p class="empty">Loading…</p>';

    api('today').then(function (d) {
      var t = d.tiles;
      var rows = d.items.map(function (it, i) {
        return '<li class="inbox__row' + (it.urgent ? ' is-urgent' : '') + '" data-i="' + i + '">' +
          '<span class="inbox__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
            'stroke-linecap="round" stroke-linejoin="round"><path d="' + (KIND_ICON[it.kind] || KIND_ICON.enquiry) + '"/></svg></span>' +
          '<span class="inbox__text"><strong>' + esc(it.title) + '</strong><span>' + esc(it.detail || '') + '</span></span>' +
          '<span class="inbox__meta"><span class="inbox__kind">' + esc(it.kind) + '</span>' +
            '<span class="inbox__ago">' + esc(ago(it.at)) + '</span></span>' +
          '<button class="btn btn--ghost btn--sm inbox__do" type="button">' + esc(it.action) + '</button></li>';
      }).join('');

      $('#view').innerHTML =
        '<section class="inbox">' +
          '<header class="inbox__head"><h2>' + d.items.length + ' waiting on you</h2>' +
            '<span class="inbox__all">' + (d.items.length ? 'Oldest first is fine — nothing here is stale yet'
              : 'Everything urgent is done') + '</span></header>' +
          (d.items.length ? '<ul class="inbox__list">' + rows + '</ul>'
            : '<p class="empty">Nothing is waiting. New applications, enquiries, maintenance, notices and reviews ' +
              'land here the moment they are submitted on the website.</p>') +
        '</section>' +
        '<div class="tiles">' +
          tile('Awaiting review', t.awaiting_review, 'Applications', 'applications') +
          tile('Open maintenance', t.open_maintenance, t.maintenance_urgent + ' urgent or emergency', 'maintenance') +
          tile('Cancellations open', t.cancellations_open, 'Notices being worked', 'cancellations') +
          tile('Leases to counter-sign', t.leases_countersign, 'Awaiting a signature', 'leases') +
        '</div>';

      $$('.inbox__row').forEach(function (row) {
        row.addEventListener('click', function () {
          var it = d.items[Number(row.dataset.i)];
          openFromInbox(it);
        });
      });
      $$('.tile').forEach(function (el) {
        el.addEventListener('click', function () { location.hash = '#/' + el.dataset.go; });
      });
    }).catch(function (e) { $('#view').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  function tile(label, n, sub, go) {
    return '<button class="tile' + (n > 0 ? ' is-live' : '') + '" type="button" data-go="' + go + '">' +
      '<span class="tile__label">' + esc(label) + '</span><strong>' + esc(n) + '</strong>' +
      '<span class="tile__sub">' + esc(sub) + '</span></button>';
  }

  /** Open the right record straight from the inbox row. */
  function openFromInbox(it) {
    if (it.route === 'leases') {
      location.hash = '#/leases';
      setTimeout(function () {
        api('leases').then(function (d) {
          var row = d.items.filter(function (l) { return Number(l.id) === Number(it.id); })[0];
          if (row) openLease(row);
        });
      }, 250);
      return;
    }
    if (it.route === 'reviews') {
      location.hash = '#/reviews';
      setTimeout(function () {
        api('reviews').then(function (d) {
          var row = d.items.filter(function (r) { return Number(r.id) === Number(it.id); })[0];
          if (row) openReview(row);
        });
      }, 250);
      return;
    }
    if (it.route === 'careers') { location.hash = '#/careers'; return; }

    location.hash = '#/' + it.route;
    setTimeout(function () {
      var cfg = VIEWS[it.route];
      if (!cfg) return;
      api(cfg.endpoint).then(function (d) {
        var row = d.items.filter(function (r) { return Number(r.id) === Number(it.id); })[0];
        if (row) openDetail(it.route, row);
      });
    }, 250);
  }

  /* ------------------------------- reviews ------------------------------- */
  function stars(n) {
    var out = '';
    for (var i = 1; i <= 5; i++) out += i <= Number(n) ? '★' : '☆';
    return '<span class="stars" aria-label="' + n + ' out of 5">' + out + '</span>';
  }

  function renderReviews() {
    $('#view-title').textContent = 'Reviews';
    $('#view').innerHTML =
      '<div class="toolbar">' +
        '<input id="q" type="search" placeholder="Search reviews…">' +
        '<select id="status"><option value="">All</option>' +
          ['new', 'published', 'replied', 'hidden'].map(function (s) {
            return '<option value="' + s + '">' + s + '</option>';
          }).join('') + '</select>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn--ghost btn--sm" id="x-xlsx" type="button">Excel</button>' +
      '</div><div class="tablewrap" id="table"></div>';

    var load = function () {
      var q = $('#q').value.trim();
      var st = $('#status').value;
      var qs = [];
      if (q) qs.push('q=' + encodeURIComponent(q));
      if (st) qs.push('status=' + encodeURIComponent(st));
      $('#table').innerHTML = '<p class="empty">Loading…</p>';
      api('reviews' + (qs.length ? '?' + qs.join('&') : '')).then(function (d) {
        state.rows.reviews = d.items;
        if (!d.items.length) { $('#table').innerHTML = '<p class="empty">No reviews yet.</p>'; return; }
        $('#table').innerHTML =
          '<table class="data"><thead><tr><th>Student</th><th>Residence</th><th>Rating</th><th>Review</th>' +
          '<th>Status</th><th>On site</th><th>Received</th></tr></thead><tbody>' +
          d.items.map(function (r, i) {
            return '<tr data-i="' + i + '"><td>' + esc(r.name) + '</td><td>' + esc(r.residence) + '</td>' +
              '<td>' + stars(r.rating) + '</td>' +
              '<td>' + esc(String(r.title || r.body || '').slice(0, 70)) + '…</td>' +
              '<td>' + badge(r.status) + '</td>' +
              '<td>' + (Number(r.published) ? 'Published' : '—') + '</td>' +
              '<td class="nowrap">' + esc(fmtDay(r.created_at)) + '</td></tr>';
          }).join('') + '</tbody></table>';
        $$('#table tbody tr').forEach(function (tr) {
          tr.addEventListener('click', function () { openReview(d.items[Number(tr.dataset.i)]); });
        });
      }).catch(function (e) { $('#table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
    };

    var t;
    $('#q').addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 250); });
    $('#status').addEventListener('change', load);
    $('#x-xlsx').addEventListener('click', function () { exportXlsx(state.rows.reviews || [], 'Reviews', 'reviews'); });
    state.reloadReviews = load;
    load();
  }

  function openReview(row) {
    $('#detail-title').textContent = 'Review';
    $('#detail-body').innerHTML =
      '<dl>' + [['Reference', row.ref], ['Student', row.name], ['Email', row.email], ['Residence', row.residence],
                ['Rating', row.rating + ' / 5'], ['Title', row.title], ['Received', fmtDate(row.created_at)]]
        .map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1] || '—') + '</dd>'; }).join('') + '</dl>' +
      '<p class="quote">' + esc(row.body) + '</p>' +
      '<div class="field"><label for="rv-status">Status</label><select id="rv-status">' +
        ['new', 'published', 'replied', 'hidden'].map(function (s) {
          return '<option value="' + s + '"' + (row.status === s ? ' selected' : '') + '>' + s + '</option>';
        }).join('') + '</select>' +
        '<span class="hint">Published and replied reviews show on the website; new and hidden do not.</span></div>' +
      '<div class="field"><label for="rv-reply">Public reply from Ligcabho</label><textarea id="rv-reply">' +
        esc(row.reply || '') + '</textarea></div>' +
      '<div class="field"><label for="rv-notes">Internal notes</label><textarea id="rv-notes">' +
        esc(row.admin_notes || '') + '</textarea></div>' +
      '<div class="actions">' +
        '<button class="btn btn--primary btn--sm" id="rv-save" type="button">Save</button>' +
        '<button class="btn btn--ghost btn--sm" id="rv-pub" type="button">Publish now</button>' +
        (row.email ? '<a class="btn btn--ghost btn--sm" href="mailto:' + esc(row.email) + '">Email</a>' : '') +
        (canManage() ? '<button class="btn btn--danger btn--sm" id="rv-del" type="button">Delete</button>' : '') +
      '</div>';
    $('#detail').hidden = false;

    var save = function (status) {
      api('reviews/' + row.id, { method: 'PATCH', body: {
        status: status || $('#rv-status').value,
        reply: $('#rv-reply').value,
        admin_notes: $('#rv-notes').value
      } }).then(function () {
        toast('Saved.', 'ok');
        $('#detail').hidden = true;
        state.reloadReviews && state.reloadReviews();
        refreshCounts();
      }).catch(function (e) { toast(e.message, 'err'); });
    };

    $('#rv-save').addEventListener('click', function () { save(); });
    $('#rv-pub').addEventListener('click', function () { save($('#rv-reply').value.trim() ? 'replied' : 'published'); });
    if ($('#rv-del')) {
      $('#rv-del').addEventListener('click', function () {
        if (!window.confirm('Delete this review permanently?')) return;
        api('reviews/' + row.id, { method: 'DELETE' }).then(function () {
          toast('Deleted.', 'ok');
          $('#detail').hidden = true;
          state.reloadReviews && state.reloadReviews();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
  }



  /* ------------------------------- messages ------------------------------ */
  /* Ready-made letters for the situations the office writes about most.
     {first_name}, {ref}, {residence}, {room} and {amount} are filled in from
     the record the message is being sent from. */
  var TEMPLATES = [
    { id: 'blank', name: 'Blank message', subject: '', body: 'Hi {first_name},\n\n' },

    { id: 'app_documents', name: 'Application: documents needed',
      subject: 'We need one more thing for your application ({ref})',
      body: 'Hi {first_name},\n\nThank you for applying to Ligcabho. Before we can confirm a room we still need:\n\n' +
            '  - your proof of payment or funding letter\n  - proof of registration at your institution\n\n' +
            'You can reply to this email with them, or WhatsApp them to 071 640 1574 with your reference {ref}.\n\n' +
            'Once we have them your application goes straight to placement.' },

    { id: 'app_accepted', name: 'Application: accepted',
      subject: 'Good news about your Ligcabho application ({ref})',
      body: 'Hi {first_name},\n\nYour application has been accepted. We are holding a place for you at {residence}.\n\n' +
            'Your lease agreement will be emailed to you shortly. Open the link, read it, and sign it online — your ' +
            'room is confirmed once it is signed and your first payment is in.\n\nWelcome to Ligcabho.' },

    { id: 'app_waitlist', name: 'Application: waitlisted',
      subject: 'Your Ligcabho application is on the waiting list ({ref})',
      body: 'Hi {first_name},\n\nThe house you asked for is full for now, so your application is on our waiting list. ' +
            'Rooms open up regularly as students confirm or withdraw, and we work through the list in order.\n\n' +
            'If you would take a room at another of our residences, reply and say so — it usually means a place sooner.' },

    { id: 'app_declined', name: 'Application: not successful',
      subject: 'About your Ligcabho application ({ref})',
      body: 'Hi {first_name},\n\nThank you for applying to Ligcabho. We are not able to offer you a room for the year ' +
            'you applied for.\n\nYou are welcome to apply again for the next intake, and we will keep your details on ' +
            'file so it is quicker next time.' },

    { id: 'placement', name: 'Placement confirmed',
      subject: 'Your room at {residence} is confirmed',
      body: 'Hi {first_name},\n\nYour room is confirmed:\n\n  Residence: {residence}\n  Room: {room}\n\n' +
            'Bring your ID, proof of registration and your funding letter on move-in day. The house rules and the ' +
            'emergency numbers are issued with your lease, and are on the website.' },

    { id: 'payment_reminder', name: 'Payment reminder',
      subject: 'A reminder about your Ligcabho account ({ref})',
      body: 'Hi {first_name},\n\nOur records show an amount of R{amount} outstanding on your account.\n\n' +
            'Payment details:\n  Bank: FNB\n  Account name: Ligcabho Properties\n  Account number: 62653880552\n' +
            '  Reference: {ref}\n\nIf you have already paid, please send the proof of payment so we can match it. ' +
            'If something has gone wrong with your funding, tell us — we would rather arrange something than let it build up.' },

    { id: 'maintenance_update', name: 'Maintenance update',
      subject: 'Your maintenance request {ref}',
      body: 'Hi {first_name},\n\nAn update on the fault you reported at {residence}, room {room}:\n\n' +
            '  [what has been done, and when the rest happens]\n\n' +
            'If it is not right, reply to this email and we will send someone back.' },

    { id: 'vacate', name: 'Notice acknowledged',
      subject: 'We have your notice to vacate ({ref})',
      body: 'Hi {first_name},\n\nYour notice is acknowledged. Before you go:\n\n' +
            '  1. Collect a vacate note from the office 24 hours before you leave.\n' +
            '  2. Your room will be inspected — damages are charged to your account.\n' +
            '  3. A vacate note is only issued once the account is settled.\n' +
            '  4. Any refund is paid after deductions, to the account you gave us.\n\n' +
            'Thank you for staying with us.' },

    { id: 'refund_approved', name: 'Refund approved',
      subject: 'Your refund claim {ref} is approved',
      body: 'Hi {first_name},\n\nYour claim for R{amount} has been checked and approved. Payment goes out on our next ' +
            'payment run, into the account you gave us.\n\nIf your banking details have changed since you claimed, ' +
            'reply to this email before then.' },

    { id: 'retention', name: 'Retention: place held',
      subject: 'Your place for next year at Ligcabho ({ref})',
      body: 'Hi {first_name},\n\nThank you for telling us you are coming back. Returning students are placed before ' +
            'new applications, so we are holding a room for you at {residence} while we confirm your account and your ' +
            'funding.\n\nYour new lease will be emailed to you to sign once placement is final.' },

    { id: 'newsletter', name: 'Announcement to a group',
      subject: 'News from Ligcabho Le’Africa Residences',
      body: 'Hi {first_name},\n\n[your announcement]\n\nIf you have any questions, call 013 752 4161 or WhatsApp ' +
            '071 640 1574.' }
  ];

  function fillTemplate(text, row) {
    row = row || {};
    var first = row.first_name || String(row.name || row.tenant_name || '').split(' ')[0] || 'there';
    return String(text || '')
      .replace(/\{first_name\}/g, first)
      .replace(/\{name\}/g, row.name || ((row.first_name || '') + ' ' + (row.last_name || '')).trim() || 'there')
      .replace(/\{ref\}/g, row.ref || '')
      .replace(/\{residence\}/g, row.residence || row.current_residence || row.preferred_residence || 'your residence')
      .replace(/\{room\}/g, row.room || row.room_number || row.current_room || '')
      .replace(/\{amount\}/g, row.amount || row.total || '')
      /* Writing to somebody with no record leaves gaps: "your account ()"
         reads badly, so drop the brackets the placeholder left behind. */
      .replace(/ *\(\s*\)/g, '');
  }

  /** Compose to one person, optionally about a record. */
  function compose(opts) {
    opts = opts || {};
    var row = opts.row || {};
    $('#detail-title').textContent = 'Send an email';
    $('#detail-body').innerHTML =
      '<form id="msg-form">' +
        '<div class="field"><label for="ms-to">To *</label>' +
          '<input id="ms-to" type="email" value="' + esc(opts.email || row.email || row.tenant_email || '') + '" required></div>' +
        '<div class="field"><label for="ms-name">Their name</label>' +
          '<input id="ms-name" value="' + esc(opts.name || ((row.first_name || '') + ' ' + (row.last_name || '')).trim() || row.name || '') + '"></div>' +
        '<div class="field"><label for="ms-template">Start from</label><select id="ms-template">' +
          TEMPLATES.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label for="ms-subject">Subject *</label><input id="ms-subject" required></div>' +
        '<div class="field"><label for="ms-body">Message *</label><textarea id="ms-body" rows="12" required></textarea>' +
          '<span class="hint">Your name, phone number and the website are added at the bottom automatically.</span></div>' +
        '<p class="note">It is sent from ' + esc(state.mailFrom || 'the address in api/config.php') +
          ', and a copy is kept under Messages.</p>' +
        '<div class="actions"><button class="btn btn--primary btn--sm" type="submit">Send it</button>' +
          '<button class="btn btn--ghost btn--sm" id="ms-cancel" type="button">Cancel</button></div>' +
      '</form>';
    $('#detail').hidden = false;

    var apply = function () {
      var t = TEMPLATES.filter(function (x) { return x.id === $('#ms-template').value; })[0];
      if (!t) return;
      $('#ms-subject').value = fillTemplate(t.subject, row);
      $('#ms-body').value = fillTemplate(t.body, row);
    };
    $('#ms-template').addEventListener('change', apply);
    apply();

    $('#ms-cancel').addEventListener('click', function () { $('#detail').hidden = true; });
    $('#msg-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('#msg-form button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      api('messages', { method: 'POST', body: {
        to_email: $('#ms-to').value.trim(), to_name: $('#ms-name').value.trim(),
        subject: $('#ms-subject').value.trim(), body: $('#ms-body').value,
        template: $('#ms-template').value,
        related_kind: opts.kind || '', related_id: row.id || 0, related_ref: row.ref || ''
      } }).then(function (d) {
        toast(d.message, d.sent ? 'ok' : 'err');
        if (d.sent) $('#detail').hidden = true;
        else { btn.disabled = false; btn.textContent = 'Try again'; }
      }).catch(function (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = 'Send it';
      });
    });
  }

  /* ------- messages: letters, the delivery log, and the setup ------- */

  function renderMessages(tab) {
    tab = tab || 'letters';
    if (tab === 'setup' && !canManage()) tab = 'letters';
    $('#view-title').textContent = 'Messages';

    var tabs = [['letters', 'Letters'], ['delivery', 'Delivery']];
    if (canManage()) tabs.push(['setup', 'Setup']);

    $('#view').innerHTML =
      '<div class="tabs">' + tabs.map(function (t) {
        return '<button class="tab' + (t[0] === tab ? ' is-on' : '') + '" data-tab="' + t[0] + '" type="button">' +
          esc(t[1]) + '</button>';
      }).join('') + '</div><div id="pane"></div>';

    $$('#view .tab').forEach(function (b) {
      b.addEventListener('click', function () {
        location.hash = '#/messages' + (b.dataset.tab === 'letters' ? '' : '/' + b.dataset.tab);
      });
    });

    if (tab === 'delivery') renderMailLog();
    else if (tab === 'setup') renderMailSetup();
    else renderLetters();
  }

  function renderLetters() {
    $('#pane').innerHTML =
      '<div class="toolbar">' +
        '<input id="q" type="search" placeholder="Search by name, address, subject or reference…">' +
        '<span class="spacer"></span>' +
        '<button class="btn btn--primary btn--sm" id="ms-new" type="button">Write a message</button>' +
        (canManage() ? '<button class="btn btn--ghost btn--sm" id="ms-bulk" type="button">Message a group</button>' : '') +
        '<button class="btn btn--ghost btn--sm" id="ms-test" type="button">Test email</button>' +
      '</div>' +
      '<div id="mail-state"></div>' +
      '<div class="tablewrap" id="table"><p class="empty">Loading…</p></div>';

    var load = function () {
      var q = $('#q').value.trim();
      api('messages' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (d) {
        state.rows.messages = d.items;
        if (!d.items.length) {
          $('#table').innerHTML = '<p class="empty">No messages sent from the portal yet.</p>';
          return;
        }
        $('#table').innerHTML =
          '<table class="data"><thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>About</th>' +
          '<th>By</th><th>Status</th></tr></thead><tbody>' +
          d.items.map(function (m, i) {
            return '<tr data-i="' + i + '"><td class="nowrap">' + esc(fmtDate(m.created_at)) + '</td>' +
              '<td>' + esc(m.to_name || m.to_email) + (m.to_name ? '<br><span class="muted">' + esc(m.to_email) + '</span>' : '') + '</td>' +
              '<td>' + esc(m.subject) + '</td>' +
              '<td>' + esc(m.related_ref || m.related_kind || '—') + '</td>' +
              '<td class="muted">' + esc(m.sent_by) + '</td>' +
              '<td>' + (m.status === 'sent' ? badge('paid') : badge('rejected')) + '</td></tr>';
          }).join('') + '</tbody></table>';
        $$('#table tbody tr').forEach(function (tr) {
          tr.addEventListener('click', function () { openMessage(d.items[Number(tr.dataset.i)]); });
        });
      }).catch(function (e) { $('#table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
    };

    /* Say plainly whether this server can send at all. */
    mailState('#mail-state');

    var t;
    $('#q').addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 250); });
    $('#ms-new').addEventListener('click', function () { compose({}); });
    if ($('#ms-bulk')) $('#ms-bulk').addEventListener('click', composeBulk);
    $('#ms-test').addEventListener('click', sendTest);
    state.reloadMessages = load;
    load();
  }

  /** The one-line truth about email on this server. */
  function mailState(sel) {
    api('mail-test').then(function (d) {
      var c = d.config;
      var how = c.transport === 'smtp'
        ? 'through <strong>' + esc(c.smtp_host || 'SMTP') + '</strong>'
        : "through the host's own mail server";
      $(sel).innerHTML = '<p class="note">' +
        (c.enabled
          ? 'Email is on, sent from <strong>' + esc(c.from) + '</strong> ' + how + '. The office copy goes to ' +
            esc((c.office_to || []).join(', ')) + '. Students are ' + (c.confirmations ? '' : 'not ') +
            'sent a confirmation when they apply.'
          : '<strong>Email is switched off</strong>, so nothing is being sent. Turn it on under Setup.') +
        (c.transport === 'php' && canManage()
          ? ' Sending through the host works on some servers and not others — setting up SMTP under ' +
            '<em>Setup</em> is what makes it reliable.'
          : '') +
        '</p>';
      state.mailFrom = c.from;
    }).catch(function () {});
  }

  function sendTest() {
    var to = window.prompt('Send a test email to which address?', (state.user && state.user.email) || '');
    if (!to) return;
    toast('Sending…');
    api('mail-test', { method: 'POST', body: { to: to } })
      .then(function (d) { toast(d.message, d.sent ? 'ok' : 'err'); })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  /** Everything the site has tried to send, and why anything failed. */
  function renderMailLog() {
    $('#pane').innerHTML =
      '<div class="toolbar">' +
        '<input id="q" type="search" placeholder="Search by name, address or subject…">' +
        '<select id="status"><option value="">Everything</option><option value="sent">Delivered</option>' +
          '<option value="failed">Would not send</option></select>' +
        '<span class="spacer"></span>' +
        (canManage() ? '<button class="btn btn--primary btn--sm" id="ml-retry-all" type="button">Try the failed ones again</button>' : '') +
        '<button class="btn btn--ghost btn--sm" id="ml-test" type="button">Test email</button>' +
      '</div>' +
      '<div class="tiles" id="ml-tiles"></div>' +
      '<div class="tablewrap" id="table"><p class="empty">Loading…</p></div>';

    var load = function () {
      var qs = [];
      if ($('#q').value.trim()) qs.push('q=' + encodeURIComponent($('#q').value.trim()));
      if ($('#status').value) qs.push('status=' + $('#status').value);
      api('mail-log' + (qs.length ? '?' + qs.join('&') : '')).then(function (d) {
        state.rows.maillog = d.items;
        $('#ml-tiles').innerHTML =
          tile('Delivered', d.counts.sent || 0, 'Emails the mail server accepted', 'sent') +
          tile('Would not send', d.counts.failed || 0, 'Open one to see the reason', 'failed');
        $$('#ml-tiles .tile').forEach(function (b) {
          b.addEventListener('click', function () {
            $('#status').value = $('#status').value === b.dataset.go ? '' : b.dataset.go;
            load();
          });
        });
        if (!d.items.length) {
          $('#table').innerHTML = '<p class="empty">Nothing has been sent yet.</p>';
          return;
        }
        $('#table').innerHTML =
          '<table class="data"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>About</th>' +
          '<th>Sent by</th><th>Status</th></tr></thead><tbody>' +
          d.items.map(function (m, i) {
            return '<tr data-i="' + i + '"><td class="nowrap">' + esc(fmtDate(m.created_at)) + '</td>' +
              '<td>' + esc(m.to_name || m.to_email) + (m.to_name ? '<br><span class="muted">' + esc(m.to_email) + '</span>' : '') + '</td>' +
              '<td>' + esc(m.subject) + '</td>' +
              '<td class="muted">' + esc(String(m.kind || '—').replace(/_/g, ' ')) + '</td>' +
              '<td class="muted">' + esc(m.transport === 'smtp' ? 'SMTP' : (m.transport === 'off' ? 'switched off' : 'the host')) + '</td>' +
              '<td>' + (m.status === 'sent' ? badge('paid') : badge('rejected')) + '</td></tr>';
          }).join('') + '</tbody></table>';
        $$('#table tbody tr').forEach(function (tr) {
          tr.addEventListener('click', function () { openMailLog(d.items[Number(tr.dataset.i)]); });
        });
      }).catch(function (e) { $('#table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
    };

    var t;
    $('#q').addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 250); });
    $('#status').addEventListener('change', load);
    $('#ml-test').addEventListener('click', sendTest);
    if ($('#ml-retry-all')) {
      $('#ml-retry-all').addEventListener('click', function () {
        toast('Trying again…');
        api('mail-log/retry-failed', { method: 'POST', body: {} })
          .then(function (d) { toast(d.message, d.failed ? 'err' : 'ok'); load(); })
          .catch(function (e) { toast(e.message, 'err'); });
      });
    }
    state.reloadMailLog = load;
    load();
  }

  function openMailLog(m) {
    $('#detail-title').textContent = m.status === 'sent' ? 'Delivered' : 'Would not send';
    $('#detail-body').innerHTML =
      '<dl>' + [['When', fmtDate(m.created_at)],
                ['To', m.to_name ? m.to_name + ' (' + m.to_email + ')' : m.to_email],
                ['Subject', m.subject], ['About', String(m.kind || '').replace(/_/g, ' ')],
                ['Sent by', m.transport === 'smtp' ? 'SMTP' : (m.transport === 'off' ? 'nothing, email is off' : "the host's mail server")],
                ['Tries', m.attempts], ['Delivered', fmtDate(m.sent_at)]]
        .filter(function (f) { return f[1]; })
        .map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl>' +
      (m.error ? '<p class="msg msg--err">' + esc(m.error) + '</p>' : '') +
      '<div class="actions">' +
        (m.status === 'sent' ? '' : '<button class="btn btn--primary btn--sm" id="ml-retry" type="button">Try again</button>') +
        (canManage() ? '<button class="btn btn--danger btn--sm" id="ml-del" type="button">Remove from the log</button>' : '') +
      '</div>';
    $('#detail').hidden = false;

    if ($('#ml-retry')) {
      $('#ml-retry').addEventListener('click', function () {
        toast('Sending…');
        api('mail-log/' + m.id + '/retry', { method: 'POST', body: {} }).then(function (d) {
          toast(d.message, d.sent ? 'ok' : 'err');
          if (d.sent) $('#detail').hidden = true;
          state.reloadMailLog && state.reloadMailLog();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
    if ($('#ml-del')) {
      $('#ml-del').addEventListener('click', function () {
        if (!window.confirm('Remove this line from the log?')) return;
        api('mail-log/' + m.id, { method: 'DELETE' }).then(function () {
          toast('Removed.', 'ok');
          $('#detail').hidden = true;
          state.reloadMailLog && state.reloadMailLog();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
  }

  /** Where the office points the site at a real mailbox. */
  function renderMailSetup() {
    $('#pane').innerHTML = '<p class="empty">Loading…</p>';
    api('mail-settings').then(function (d) {
      var t = d.settings;
      var opt = function (v, label, sel) {
        return '<option value="' + v + '"' + (sel === v ? ' selected' : '') + '>' + esc(label) + '</option>';
      };
      $('#pane').innerHTML =
        '<form id="mail-form" class="panel">' +
          '<h3>How email leaves this website</h3>' +
          '<p class="note">Everything students and the office are sent goes out this way. After saving, send ' +
            'yourself a test — that is the only proof that it works.</p>' +
          '<div class="grid2">' +
            '<div class="field"><label for="mf-transport">Send email</label><select id="mf-transport">' +
              opt('auto', 'Automatically (SMTP when it is filled in)', t.transport) +
              opt('smtp', 'Through a mailbox (SMTP) — reliable', t.transport) +
              opt('php', "Through the host's own mail server", t.transport) +
            '</select><span class="hint">Currently sending ' +
              (t.resolved === 'smtp' ? 'through SMTP.' : "through the host's mail server.") + '</span></div>' +
            '<div class="field"><label for="mf-enabled">Email is</label><select id="mf-enabled">' +
              opt('1', 'On', t.enabled ? '1' : '0') + opt('0', 'Off — save everything, send nothing', t.enabled ? '1' : '0') +
            '</select></div>' +
          '</div>' +
          '<div class="grid2">' +
            '<div class="field"><label for="mf-from">Send from *</label>' +
              '<input id="mf-from" type="email" value="' + esc(t.from) + '" required>' +
              '<span class="hint">Must be a real mailbox on this domain.</span></div>' +
            '<div class="field"><label for="mf-fromname">Shown as</label>' +
              '<input id="mf-fromname" value="' + esc(t.from_name) + '"></div>' +
          '</div>' +
          '<div class="grid2">' +
            '<div class="field"><label for="mf-reply">Replies go to</label>' +
              '<input id="mf-reply" type="email" value="' + esc(t.reply_to) + '"></div>' +
            '<div class="field"><label for="mf-office">Copy submissions to *</label>' +
              '<input id="mf-office" value="' + esc(t.office_to) + '" required>' +
              '<span class="hint">One or more addresses, separated by commas.</span></div>' +
          '</div>' +
          '<div class="field"><label for="mf-conf">When a student applies</label><select id="mf-conf">' +
            opt('1', 'Email them their reference and what happens next', t.confirmations ? '1' : '0') +
            opt('0', 'Send them nothing', t.confirmations ? '1' : '0') +
          '</select></div>' +

          '<h3>The mailbox to send through (SMTP)</h3>' +
          '<p class="note">For the domain\u2019s own mailbox: host <code>mail.ligcabhoresidences.co.za</code>, port 587, ' +
            'TLS, username the full address. For Gmail: <code>smtp.gmail.com</code>, port 587, TLS, and an ' +
            '<strong>app password</strong> — not the account password.</p>' +
          '<div class="grid2">' +
            '<div class="field"><label for="mf-host">Server</label>' +
              '<input id="mf-host" value="' + esc(t.host) + '" placeholder="mail.ligcabhoresidences.co.za"></div>' +
            '<div class="field"><label for="mf-port">Port</label>' +
              '<input id="mf-port" type="number" value="' + esc(t.port) + '"></div>' +
          '</div>' +
          '<div class="grid2">' +
            '<div class="field"><label for="mf-sec">Security</label><select id="mf-sec">' +
              opt('tls', 'TLS (port 587)', t.security) + opt('ssl', 'SSL (port 465)', t.security) +
              opt('none', 'None', t.security) +
            '</select></div>' +
            '<div class="field"><label for="mf-user">Username</label>' +
              '<input id="mf-user" value="' + esc(t.username) + '" autocomplete="off"></div>' +
          '</div>' +
          '<div class="field"><label for="mf-verify">Certificate</label><select id="mf-verify">' +
            opt('1', 'Check it (normal)', t.verify ? '1' : '0') +
            opt('0', 'Do not check it — if the host\u2019s certificate is for another name', t.verify ? '1' : '0') +
          '</select></div>' +
          '<div class="field"><label for="mf-pass">Password</label>' +
            '<input id="mf-pass" type="password" autocomplete="new-password" placeholder="' +
            (t.has_password ? 'Saved — leave empty to keep it' : 'The mailbox password') + '">' +
            '<span class="hint">Kept in the site\u2019s own database and never shown again.</span></div>' +
          '<div class="actions">' +
            '<button class="btn btn--primary btn--sm" type="submit">Save</button>' +
            '<button class="btn btn--ghost btn--sm" id="mf-test" type="button">Save and send a test</button>' +
          '</div>' +
        '</form>';

      var save = function () {
        return api('mail-settings', { method: 'POST', body: {
          enabled: $('#mf-enabled').value === '1',
          transport: $('#mf-transport').value,
          from: $('#mf-from').value.trim(),
          from_name: $('#mf-fromname').value.trim(),
          reply_to: $('#mf-reply').value.trim(),
          office_to: $('#mf-office').value.trim(),
          confirmations: $('#mf-conf').value === '1',
          host: $('#mf-host').value.trim(),
          port: Number($('#mf-port').value) || 587,
          security: $('#mf-sec').value,
          username: $('#mf-user').value.trim(),
          password: $('#mf-pass').value,
          verify: $('#mf-verify').value === '1'
        } });
      };

      $('#mail-form').addEventListener('submit', function (e) {
        e.preventDefault();
        save().then(function (d) { toast(d.message, 'ok'); $('#mf-pass').value = ''; })
              .catch(function (err) { toast(err.message, 'err'); });
      });
      $('#mf-test').addEventListener('click', function () {
        save().then(function () { $('#mf-pass').value = ''; sendTest(); })
              .catch(function (err) { toast(err.message, 'err'); });
      });
    }).catch(function (e) { $('#pane').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  function openMessage(m) {
    $('#detail-title').textContent = 'Message ' + m.ref;
    $('#detail-body').innerHTML =
      '<dl>' + [['Sent', fmtDate(m.created_at)], ['To', m.to_name ? m.to_name + ' (' + m.to_email + ')' : m.to_email],
                ['Subject', m.subject], ['About', m.related_ref || m.related_kind], ['Sent by', m.sent_by],
                ['Status', m.status], ['Problem', m.error]]
        .filter(function (f) { return f[1]; })
        .map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl>' +
      '<p class="quote">' + esc(m.body) + '</p>' +
      '<div class="actions">' +
        '<button class="btn btn--primary btn--sm" id="ms-again" type="button">Write to them again</button>' +
        (canManage() ? '<button class="btn btn--danger btn--sm" id="ms-del" type="button">Delete the record</button>' : '') +
      '</div>';
    $('#detail').hidden = false;
    $('#ms-again').addEventListener('click', function () {
      compose({ email: m.to_email, name: m.to_name });
    });
    if ($('#ms-del')) {
      $('#ms-del').addEventListener('click', function () {
        if (!window.confirm('Delete this record? The email itself has already gone.')) return;
        api('messages/' + m.id, { method: 'DELETE' }).then(function () {
          toast('Deleted.', 'ok');
          $('#detail').hidden = true;
          state.reloadMessages && state.reloadMessages();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
  }

  /**
   * Every email this person has been sent, under their record.
   *
   * Both kinds: the letters the office wrote, and the ones the website sent
   * by itself when they applied, were sent a lease or were invoiced. So a
   * question like "has anyone actually told them?" is answered where the
   * record is, not by searching a log.
   */
  function mailHistory(sel, email, kind, id) {
    var box = $(sel);
    if (!box) return;
    if (!email && !id) { box.innerHTML = ''; return; }

    var qs = [];
    if (email) qs.push('email=' + encodeURIComponent(email));
    if (kind && id) qs.push('related_kind=' + encodeURIComponent(kind) + '&related_id=' + id);

    box.innerHTML = '<h3 class="detail__sub">Emails</h3><p class="muted">Looking&hellip;</p>';
    api('correspondence?' + qs.join('&')).then(function (d) {
      if (!d.items.length) {
        box.innerHTML = '<h3 class="detail__sub">Emails</h3>' +
          '<p class="muted">Nothing has been emailed to this address yet.</p>';
        return;
      }
      box.innerHTML =
        '<h3 class="detail__sub">Emails <span class="muted">(' + d.items.length +
          (d.counts.failed ? ', ' + d.counts.failed + ' did not send' : '') + ')</span></h3>' +
        '<ol class="thread">' + d.items.map(function (m, i) {
          return '<li class="thread__item" data-i="' + i + '">' +
            '<button class="thread__head" type="button">' +
              '<span class="thread__subject">' + esc(m.subject) + '</span>' +
              '<span class="thread__meta">' + esc(fmtDate(m.created_at)) + ' · ' + esc(m.by) +
                (m.status === 'sent' ? '' : ' · <strong>did not send</strong>') + '</span>' +
            '</button>' +
            '<div class="thread__body" hidden><p class="quote">' + esc(m.body || '') + '</p>' +
              (m.error ? '<p class="msg msg--err">' + esc(m.error) + '</p>' : '') +
              '<p class="muted">' + esc(m.kind) + ' · sent to ' + esc(m.to_email) + '</p></div>' +
            '</li>';
        }).join('') + '</ol>';

      $$(sel + ' .thread__head').forEach(function (b) {
        b.addEventListener('click', function () {
          var body = b.nextElementSibling;
          body.hidden = !body.hidden;
          b.classList.toggle('is-open', !body.hidden);
        });
      });
    }).catch(function (e) {
      box.innerHTML = '<h3 class="detail__sub">Emails</h3><p class="muted">' + esc(e.message) + '</p>';
    });
  }

  /** The same letter to everyone on a list. */
  function composeBulk() {
    $('#detail-title').textContent = 'Message a group';
    $('#detail-body').innerHTML =
      '<form id="bulk-form">' +
        '<div class="field"><label for="bk-group">Who</label><select id="bk-group">' +
          '<option value="subscribers">Newsletter subscribers</option>' +
          '<option value="applications:new">Applicants awaiting review</option>' +
          '<option value="applications:accepted">Applicants accepted</option>' +
          '<option value="applications:waitlist">Applicants on the waiting list</option>' +
          '<option value="retentions:yes">Students coming back next year</option>' +
          '<option value="leases:signed">Tenants with a signed lease</option>' +
        '</select><span class="hint" id="bk-count">Counting…</span></div>' +
        '<div class="field"><label for="bk-template">Start from</label><select id="bk-template">' +
          TEMPLATES.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label for="bk-subject">Subject *</label><input id="bk-subject" required></div>' +
        '<div class="field"><label for="bk-body">Message *</label><textarea id="bk-body" rows="12" required></textarea>' +
          '<span class="hint">Write {first_name} where their name should go.</span></div>' +
        '<p class="note">Each person gets their own email — nobody sees anybody else’s address.</p>' +
        '<div class="actions"><button class="btn btn--primary btn--sm" type="submit">Send to the group</button>' +
          '<button class="btn btn--ghost btn--sm" id="bk-cancel" type="button">Cancel</button></div>' +
      '</form>';
    $('#detail').hidden = false;

    var people = [];
    var gather = function () {
      var choice = $('#bk-group').value.split(':');
      var what = choice[0];
      var filter = choice[1] || '';
      $('#bk-count').textContent = 'Counting…';
      people = [];
      var endpoint = what === 'retentions' ? 'retentions' : what;
      api(endpoint).then(function (d) {
        (d.items || []).forEach(function (r) {
          if (what === 'applications' && filter && r.status !== filter) return;
          if (what === 'retentions' && r.coming_back !== 'yes') return;
          if (what === 'leases' && ['signed', 'countersigned'].indexOf(r.status) === -1) return;
          var email = r.email || r.tenant_email;
          if (!email) return;
          var name = r.name || ((r.first_name || r.tenant_name || '') + ' ' +
                     (r.last_name || r.tenant_surname || '')).trim();
          people.push({ email: email, name: name });
        });
        $('#bk-count').textContent = people.length + (people.length === 1 ? ' person' : ' people');
      }).catch(function (e) { $('#bk-count').textContent = e.message; });
    };
    $('#bk-group').addEventListener('change', gather);
    gather();

    var applyT = function () {
      var t = TEMPLATES.filter(function (x) { return x.id === $('#bk-template').value; })[0];
      if (!t) return;
      $('#bk-subject').value = t.subject.replace(/\{[a-z_]+\}/g, '');
      $('#bk-body').value = t.body;
    };
    $('#bk-template').addEventListener('change', applyT);
    $('#bk-template').value = 'newsletter';
    applyT();

    $('#bk-cancel').addEventListener('click', function () { $('#detail').hidden = true; });
    $('#bulk-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!people.length) return toast('That group has nobody in it yet.', 'err');
      if (!window.confirm('Send this to ' + people.length + ' people?')) return;
      var btn = $('#bulk-form button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      api('messages/bulk', { method: 'POST', body: {
        recipients: people, subject: $('#bk-subject').value.trim(), body: $('#bk-body').value,
        template: $('#bk-template').value, related_kind: 'bulk'
      } }).then(function (d) {
        toast(d.message, d.failed ? 'err' : 'ok');
        $('#detail').hidden = true;
        state.reloadMessages && state.reloadMessages();
      }).catch(function (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = 'Send to the group';
      });
    });
  }

  /* -------------------------------- finance ------------------------------ */
  function plural(n, word) {
    return n + ' ' + word + (Number(n) === 1 ? '' : 's');
  }

  function rands(v) {
    var n = Number(String(v == null ? 0 : v).replace(/[^\d.-]/g, '')) || 0;
    return 'R' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function renderFinance() {
    if (!state.rows.residences) {
      api('residences').then(function (d) { state.rows.residences = d.items; renderFinance(); })
        .catch(function () { state.rows.residences = []; renderFinance(); });
      return;
    }
    $('#view-title').textContent = 'Finance';
    $('#view').innerHTML = '<p class="empty">Loading…</p>';

    Promise.all([api('finance'), api('invoices'), api('refunds')]).then(function (res) {
      var f = res[0].finance;
      var invoices = res[1].items;
      var refunds = res[2].items;
      state.rows.invoices = invoices;
      state.rows.refunds = refunds;

      var invRows = invoices.length ? invoices.map(function (v, i) {
        var overdue = v.kind === 'invoice' && v.status === 'sent' && v.due_on && v.due_on < f.today;
        return '<tr data-i="' + i + '"' + (overdue ? ' class="is-overdue"' : '') + '>' +
          '<td>' + esc(v.ref) + '</td>' +
          '<td><span class="badge">' + esc(v.kind) + '</span></td>' +
          '<td>' + esc(v.name) + (v.room ? '<br><span class="muted">Room ' + esc(v.room) + '</span>' : '') + '</td>' +
          '<td>' + esc(rands(v.total)) + '</td>' +
          '<td class="nowrap">' + esc(v.due_on || '—') + (overdue ? ' <span class="badge badge--rejected">overdue</span>' : '') + '</td>' +
          '<td>' + badge(v.status) + '</td>' +
          '<td class="nowrap">' + esc(fmtDay(v.created_at)) + '</td></tr>';
      }).join('') : '';

      var refundRows = refunds.length ? refunds.map(function (r, i) {
        return '<tr data-r="' + i + '"><td>' + esc(r.ref) + '</td>' +
          '<td>' + esc(r.name) + (r.room ? '<br><span class="muted">Room ' + esc(r.room) + '</span>' : '') + '</td>' +
          '<td>' + esc(String(r.reason || '').slice(0, 44)) + '</td>' +
          '<td>' + esc(rands(r.amount)) + '</td>' +
          '<td>' + (r.pop_stored ? '1' : '—') + '</td>' +
          '<td>' + badge(r.status) + '</td>' +
          '<td class="nowrap">' + esc(fmtDay(r.created_at)) + '</td></tr>';
      }).join('') : '';

      $('#view').innerHTML =
        '<div class="tiles">' +
          tile('Outstanding', rands(f.outstanding), plural(f.outstanding_count, 'unpaid invoice'), 'finance') +
          tile('Overdue', rands(f.overdue), plural(f.overdue_count, 'invoice') + ' past the due date', 'finance') +
          tile('Invoices', f.invoices, 'All time, plus ' + plural(f.quotes, 'quote'), 'finance') +
          tile('Refunds to pay', rands(f.refunds_due), plural(f.refunds_open, 'open request'), 'refunds') +
        '</div>' +

        '<div class="panel">' +
          '<div class="panel__head"><h2>Invoices and quotes</h2><div class="panel__actions">' +
            (canManage() ? '<button class="btn btn--primary btn--sm" id="fin-new-invoice" type="button">New invoice</button>' +
                           '<button class="btn btn--ghost btn--sm" id="fin-new-quote" type="button">New quote</button>' : '') +
            '<button class="btn btn--ghost btn--sm" id="fin-xlsx" type="button">Excel</button>' +
            '<button class="btn btn--ghost btn--sm" id="fin-csv" type="button">CSV</button>' +
            '<button class="btn btn--ghost btn--sm" id="fin-refresh" type="button">Refresh</button>' +
          '</div></div>' +
          '<p class="note">Build a quote or an invoice, send it, and the student gets it by email with the banking ' +
            'details and the reference on it. They can be downloaded as a PDF, and overdue invoices are flagged here ' +
            'and counted above.</p>' +
          (invRows
            ? '<div class="tablewrap"><table class="data"><thead><tr><th>Reference</th><th>Type</th><th>To</th>' +
              '<th>Amount</th><th>Due</th><th>Status</th><th>Created</th></tr></thead><tbody>' + invRows +
              '</tbody></table></div>'
            : '<p class="empty">No invoices yet.</p>') +
        '</div>' +

        '<div class="panel">' +
          '<div class="panel__head"><h2>Refund requests</h2><div class="panel__actions">' +
            '<button class="btn btn--ghost btn--sm" id="ref-xlsx" type="button">Excel</button>' +
            '<button class="btn btn--ghost btn--sm" id="ref-csv" type="button">CSV</button>' +
          '</div></div>' +
          '<p class="note">Refunds students ask for through the Student Zone, with their proof of payment and banking ' +
            'details attached. Open one to check the documents, approve it and tell them.</p>' +
          (refundRows
            ? '<div class="tablewrap"><table class="data"><thead><tr><th>Ticket</th><th>Name</th><th>Reason</th>' +
              '<th>Amount</th><th>Proof</th><th>Status</th><th>Asked</th></tr></thead><tbody>' + refundRows +
              '</tbody></table></div>'
            : '<p class="empty">No refund requests yet.</p>') +
        '</div>';

      $$('.tile').forEach(function (el) {
        el.addEventListener('click', function () { if (el.dataset.go !== 'finance') location.hash = '#/' + el.dataset.go; });
      });
      $$('#view tbody tr[data-i]').forEach(function (tr) {
        tr.addEventListener('click', function () { openInvoice(invoices[Number(tr.dataset.i)]); });
      });
      $$('#view tbody tr[data-r]').forEach(function (tr) {
        tr.addEventListener('click', function () { openDetail('refunds', refunds[Number(tr.dataset.r)]); });
      });

      if ($('#fin-new-invoice')) $('#fin-new-invoice').addEventListener('click', function () { newInvoice('invoice'); });
      if ($('#fin-new-quote'))   $('#fin-new-quote').addEventListener('click', function () { newInvoice('quote'); });
      $('#fin-refresh').addEventListener('click', renderFinance);
      $('#fin-xlsx').addEventListener('click', function () { exportXlsx(invoices, 'Invoices', 'invoices'); });
      $('#fin-csv').addEventListener('click', function () { exportCsv(invoices, 'invoices'); });
      $('#ref-xlsx').addEventListener('click', function () { exportXlsx(refunds, 'Refunds', 'refunds'); });
      $('#ref-csv').addEventListener('click', function () { exportCsv(refunds, 'refunds'); });
    }).catch(function (e) { $('#view').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  /** Build a quote or an invoice, with as many lines as it needs. */
  function newInvoice(kind) {
    var word = kind === 'quote' ? 'quote' : 'invoice';
    $('#detail-title').textContent = 'New ' + word;

    var lineRow = function (i, desc, amount) {
      return '<div class="line" data-line="' + i + '">' +
        '<input class="line__desc" placeholder="What is it for" value="' + esc(desc || '') + '">' +
        '<input class="line__qty" inputmode="numeric" value="1" aria-label="Quantity">' +
        '<input class="line__amt" inputmode="decimal" placeholder="0.00" value="' + esc(amount || '') + '" aria-label="Amount">' +
        '</div>';
    };

    var today = new Date().toISOString().slice(0, 10);
    var due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    $('#detail-body').innerHTML =
      '<form id="inv-form">' +
        '<div class="field"><label for="in-name">Bill to *</label><input id="in-name" required></div>' +
        '<div class="field"><label for="in-email">Email *</label><input id="in-email" type="email" required></div>' +
        '<div class="field"><label for="in-phone">Phone</label><input id="in-phone" type="tel"></div>' +
        '<div class="field"><label for="in-res">Residence</label><select id="in-res"><option value="">Not set</option>' +
          (state.rows.residences || []).map(function (h) {
            return '<option value="' + esc(h.name) + '">' + esc(h.name) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label for="in-room">Room</label><input id="in-room"></div>' +
        '<div class="field"><label>Lines *</label><div id="inv-lines">' +
          lineRow(0, kind === 'quote' ? '' : 'Monthly rent', '') + '</div>' +
          '<button class="btn btn--ghost btn--sm" id="inv-add" type="button" style="margin-top:8px">Add a line</button>' +
          '<span class="hint">Description, quantity, amount in rands.</span></div>' +
        '<div class="field"><label for="in-issued">' + (kind === 'quote' ? 'Quoted on' : 'Issued on') + '</label>' +
          '<input id="in-issued" type="date" value="' + today + '"></div>' +
        '<div class="field"><label for="in-due">' + (kind === 'quote' ? 'Valid until' : 'Due by') + '</label>' +
          '<input id="in-due" type="date" value="' + due + '"></div>' +
        '<div class="field"><label for="in-note">Note on the document</label><textarea id="in-note"></textarea></div>' +
        '<p class="total-line">Total <strong id="inv-total">R0.00</strong></p>' +
        '<div class="actions"><button class="btn btn--primary btn--sm" type="submit">Create ' + word + '</button></div>' +
      '</form>';
    $('#detail').hidden = false;

    var recount = function () {
      var total = 0;
      $$('#inv-lines .line').forEach(function (l) {
        var qty = Number($('.line__qty', l).value) || 0;
        var amt = Number(String($('.line__amt', l).value).replace(/[^\d.]/g, '')) || 0;
        total += qty * amt;
      });
      $('#inv-total').textContent = rands(total);
    };
    $('#detail-body').addEventListener('input', recount);
    $('#inv-add').addEventListener('click', function () {
      $('#inv-lines').insertAdjacentHTML('beforeend', lineRow($$('#inv-lines .line').length));
    });

    $('#inv-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var items = $$('#inv-lines .line').map(function (l) {
        return {
          description: $('.line__desc', l).value.trim(),
          qty: Number($('.line__qty', l).value) || 1,
          amount: $('.line__amt', l).value
        };
      }).filter(function (l) { return l.description && l.amount; });

      if (!items.length) return toast('Add at least one line with a description and an amount.', 'err');

      api('invoices', { method: 'POST', body: {
        kind: kind, name: $('#in-name').value.trim(), email: $('#in-email').value.trim(),
        phone: $('#in-phone').value.trim(), residence: $('#in-res').value, room: $('#in-room').value.trim(),
        items: items, issued_on: $('#in-issued').value, due_on: $('#in-due').value, note: $('#in-note').value
      } }).then(function (d) {
        toast(word.charAt(0).toUpperCase() + word.slice(1) + ' ' + d.ref + ' created as a draft.', 'ok');
        $('#detail').hidden = true;
        renderFinance();
      }).catch(function (err) { toast(err.message, 'err'); });
    });
  }

  function openInvoice(v) {
    $('#detail-title').textContent = (v.kind === 'quote' ? 'Quote ' : 'Invoice ') + v.ref;
    var lines = [];
    try { lines = JSON.parse(v.items) || []; } catch (e) { lines = []; }

    $('#detail-body').innerHTML =
      '<dl>' + [['Reference', v.ref], ['Type', v.kind], ['To', v.name], ['Email', v.email], ['Phone', v.phone],
                ['Residence', v.residence], ['Room', v.room], ['Issued', v.issued_on], ['Due', v.due_on],
                ['Paid on', v.paid_on], ['Status', v.status]]
        .filter(function (f) { return f[1]; })
        .map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl>' +
      '<table class="data lines"><thead><tr><th>Line</th><th>Qty</th><th>Amount</th></tr></thead><tbody>' +
        lines.map(function (l) {
          return '<tr><td>' + esc(l.description) + '</td><td>' + esc(l.qty) + '</td><td>' +
            esc(rands(l.qty * l.amount)) + '</td></tr>';
        }).join('') +
        '<tr><td><strong>Total</strong></td><td></td><td><strong>' + esc(rands(v.total)) + '</strong></td></tr>' +
      '</tbody></table>' +
      (v.note ? '<p class="quote">' + esc(v.note) + '</p>' : '') +
      '<div class="actions">' +
        '<a class="btn btn--ghost btn--sm" href="' + API + 'invoices/' + v.id + '/pdf" target="_blank" rel="noopener">Download PDF</a>' +
        (canManage() && v.status !== 'paid'
          ? '<button class="btn btn--primary btn--sm" id="inv-send" type="button">' +
            (v.status === 'draft' ? 'Send it' : 'Send again') + '</button>' : '') +
        (canManage() && v.kind === 'invoice' && v.status !== 'paid'
          ? '<button class="btn btn--ghost btn--sm" id="inv-paid" type="button">Mark paid</button>' : '') +
        '<a class="btn btn--ghost btn--sm" href="mailto:' + esc(v.email) + '">Email</a>' +
        (canManage() ? '<button class="btn btn--danger btn--sm" id="inv-del" type="button">Delete</button>' : '') +
      '</div>';
    $('#detail').hidden = false;

    if ($('#inv-send')) {
      $('#inv-send').addEventListener('click', function () {
        api('invoices/' + v.id + '/send', { method: 'POST' }).then(function () {
          toast('Sent to ' + v.email + '.', 'ok');
          $('#detail').hidden = true;
          renderFinance();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
    if ($('#inv-paid')) {
      $('#inv-paid').addEventListener('click', function () {
        api('invoices/' + v.id + '/paid', { method: 'POST', body: {} }).then(function () {
          toast('Marked paid.', 'ok');
          $('#detail').hidden = true;
          renderFinance();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
    if ($('#inv-del')) {
      $('#inv-del').addEventListener('click', function () {
        if (!window.confirm('Delete this document permanently?')) return;
        api('invoices/' + v.id, { method: 'DELETE' }).then(function () {
          toast('Deleted.', 'ok');
          $('#detail').hidden = true;
          renderFinance();
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    }
  }

  /* -------------------------------- leases ------------------------------- */
  var LEASE_FIELDS = [
    ['tenant_name', 'First name', 'text', true], ['tenant_surname', 'Surname', 'text', true],
    ['tenant_email', 'Email', 'email', true], ['tenant_phone', 'Phone', 'tel'],
    ['tenant_id_number', 'ID number', 'text'], ['student_number', 'Student number', 'text'],
    ['institution', 'Institution', 'text'], ['course', 'Course', 'text'],
    ['year_of_study', 'Year of study', 'text'], ['residence', 'Residence', 'text'],
    ['room_number', 'Room number', 'text'], ['room_type', 'Room type', 'text'],
    ['commencement_date', 'Starts', 'date'], ['end_date', 'Ends', 'date'],
    ['monthly_rent', 'Monthly rent (R)', 'text'], ['deposit', 'Deposit (R)', 'text'],
    ['admin_fee', 'Admin fee (R)', 'text'], ['funder', 'Funder', 'text']
  ];

  function renderLeases() {
    $('#view-title').textContent = 'Leases';
    $('#view').innerHTML =
      '<div class="toolbar">' +
        (canManage() ? '<button class="btn btn--primary btn--sm" id="l-new" type="button">New lease</button>' : '') +
        '<span class="spacer"></span>' +
        '<button class="btn btn--ghost btn--sm" id="l-xlsx" type="button">Excel</button>' +
      '</div><div class="tablewrap" id="l-table"></div>';

    var load = function () {
      $('#l-table').innerHTML = '<p class="empty">Loading…</p>';
      api('leases').then(function (d) {
        state.rows.leases = d.items;
        if (!d.items.length) { $('#l-table').innerHTML = '<p class="empty">No leases yet. Create one from an accepted application.</p>'; return; }
        $('#l-table').innerHTML =
          '<table class="data"><thead><tr><th>Tenant</th><th>Residence</th><th>Room</th><th>Rent</th>' +
          '<th>Starts</th><th>Status</th><th>Signed</th></tr></thead><tbody>' +
          d.items.map(function (l, i) {
            return '<tr data-i="' + i + '"><td>' + esc(l.tenant_name + ' ' + l.tenant_surname) + '<br>' +
              '<span class="muted">' + esc(l.tenant_email) + '</span></td>' +
              '<td>' + esc(l.residence || '—') + '</td><td>' + esc(l.room_number || '—') + '</td>' +
              '<td>' + (l.monthly_rent ? 'R' + esc(l.monthly_rent) : '—') + '</td>' +
              '<td class="nowrap">' + esc(l.commencement_date || '—') + '</td>' +
              '<td>' + badge(l.status) + '</td>' +
              '<td class="nowrap">' + esc(l.tenant_signed_at ? fmtDay(l.tenant_signed_at) : '—') + '</td></tr>';
          }).join('') + '</tbody></table>';
        $$('#l-table tbody tr').forEach(function (tr) {
          tr.addEventListener('click', function () { openLease(d.items[Number(tr.dataset.i)]); });
        });
      }).catch(function (e) { $('#l-table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
    };

    if ($('#l-new')) $('#l-new').addEventListener('click', function () { newLease(null); });
    $('#l-xlsx').addEventListener('click', function () { exportXlsx(state.rows.leases || [], 'Leases', 'leases'); });
    state.reloadLeases = load;
    load();
  }

  function newLease(fromApplication, houses) {
    // Always read the rate card fresh: rates may have been edited a moment ago.
    if (!houses) {
      api('residences').then(function (d) {
        state.rows.residences = d.items;
        newLease(fromApplication, d.items);
      }).catch(function () { newLease(fromApplication, state.rows.residences || []); });
      return;
    }
    $('#detail-title').textContent = 'New lease';
    var pre = {};
    if (fromApplication) {
      pre = {
        tenant_name: fromApplication.first_name, tenant_surname: fromApplication.last_name,
        tenant_email: fromApplication.email, tenant_phone: fromApplication.phone,
        tenant_id_number: fromApplication.id_number, student_number: fromApplication.student_number,
        institution: fromApplication.institution, year_of_study: fromApplication.level_of_study,
        // a retention form carries the room they are in now, and the one they asked for
        residence: fromApplication.preferred_residence || fromApplication.residence ||
                   fromApplication.current_residence,
        room_number: fromApplication.same_room === 'yes' ? (fromApplication.current_room || '') : '',
        room_type: fromApplication.room_type, funder: fromApplication.funder
      };
    }
    var field = function (f) {
      if (f[0] === 'residence') {
        return '<div class="field"><label for="lf-residence">Residence</label>' +
          '<select id="lf-residence"><option value="">Not set</option>' +
          houses.map(function (h) {
            return '<option value="' + esc(h.name) + '"' + (pre.residence === h.name ? ' selected' : '') + '>' +
              esc(h.name) + '</option>';
          }).join('') + '</select>' +
          '<span class="hint" id="rate-hint">Pick a residence and room type to fill the rates.</span></div>';
      }
      if (f[0] === 'room_type') {
        return '<div class="field"><label for="lf-room_type">Room type</label><select id="lf-room_type">' +
          ['', 'Single room', 'Sharing room'].map(function (o) {
            return '<option value="' + esc(o) + '"' + (pre.room_type === o ? ' selected' : '') + '>' +
              esc(o || 'Not set') + '</option>';
          }).join('') + '</select></div>';
      }
      return '<div class="field"><label for="lf-' + f[0] + '">' + esc(f[1]) + (f[3] ? ' *' : '') + '</label>' +
        '<input id="lf-' + f[0] + '" type="' + f[2] + '" value="' + esc(pre[f[0]] || '') + '"' +
        (f[3] ? ' required' : '') + '></div>';
    };

    $('#detail-body').innerHTML =
      '<form id="l-form">' +
        LEASE_FIELDS.map(field).join('') +
        '<div class="field"><label for="lf-occupants">Maximum occupants (clause 5.4)</label>' +
          '<input id="lf-occupants" type="number" min="1" max="6" value="1">' +
          '<span class="hint">How many people may occupy the room. A single is 1, a sharing room is usually 2.</span></div>' +
        '<div class="field"><label for="lf-special">Special conditions (clause 12)</label><textarea id="lf-special"></textarea></div>' +
        '<div class="actions"><button class="btn btn--primary btn--sm" type="submit">Create lease</button></div>' +
      '</form>';
    $('#detail').hidden = false;

    /* The rate card fills the money fields; the office can still override them. */
    var applyRates = function (force) {
      var house = houses.filter(function (h) { return h.name === $('#lf-residence').value; })[0];
      var hint = $('#rate-hint');
      var sharing = /sharing/i.test($('#lf-room_type').value);

      /* Clause 5.4 follows the room type, whether or not a house is picked yet. */
      var occ = $('#lf-occupants');
      if (occ && (force || !occ.value)) occ.value = sharing ? 2 : 1;

      if (!house) { if (hint) hint.textContent = 'Pick a residence and room type to fill the rates.'; return; }
      var rent = sharing ? house.sharing_rate : house.single_rate;
      var set = function (id, value) {
        var el = $('#lf-' + id);
        if (el && value && (force || !el.value)) el.value = value;
      };
      set('monthly_rent', rent);
      set('deposit', house.deposit);
      set('admin_fee', house.admin_fee);
      if (hint) {
        hint.textContent = rent
          ? 'Rate card for ' + house.name + ': R' + rent + ' a month for a ' + (sharing ? 'sharing' : 'single') + ' room.'
          : 'No rate is set for ' + house.name + ' yet — set it under Residences and rates, or type it in here.';
      }
    };
    $('#lf-residence').addEventListener('change', function () { applyRates(true); });
    $('#lf-room_type').addEventListener('change', function () { applyRates(true); });
    applyRates(false);

    $('#l-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {
        special_conditions: $('#lf-special').value,
        max_occupants: Number($('#lf-occupants').value) || 1
      };
      LEASE_FIELDS.forEach(function (f) { payload[f[0]] = $('#lf-' + f[0]).value.trim(); });
      if (fromApplication) payload.application_id = fromApplication.id;
      api('leases', { method: 'POST', body: payload }).then(function (d) {
        toast('Lease created as a draft.', 'ok');
        $('#detail').hidden = true;
        if (state.reloadLeases) state.reloadLeases();
        else location.hash = '#/leases';
        window.prompt('Lease link (send it once you have checked the details):', d.link);
      }).catch(function (err) { toast(err.message, 'err'); });
    });
  }

  function openLease(row) {
    $('#detail-title').textContent = 'Lease detail';
    api('leases/' + row.id).then(function (d) {
      var l = d.lease;
      var link = location.origin + location.pathname.replace(/admin\/.*$/, '') + 'lease.html?t=' + l.token;
      var fields = [
        ['Tenant', l.tenant_name + ' ' + l.tenant_surname], ['Email', l.tenant_email], ['Phone', l.tenant_phone],
        ['ID number', l.tenant_id_number], ['Student number', l.student_number], ['Institution', l.institution],
        ['Residence', l.residence], ['Room', l.room_number], ['Room type', l.room_type],
        ['Starts', l.commencement_date], ['Ends', l.end_date], ['Monthly rent', l.monthly_rent ? 'R' + l.monthly_rent : ''],
        ['Deposit', l.deposit ? 'R' + l.deposit : ''], ['Admin fee', l.admin_fee ? 'R' + l.admin_fee : ''],
        ['Funder', l.funder], ['Status', l.status], ['Sent', l.sent_at ? fmtDate(l.sent_at) : ''],
        ['Tenant signed', l.tenant_signed_at ? fmtDate(l.tenant_signed_at) : ''],
        ['Counter-signed', l.landlord_signed_at ? fmtDate(l.landlord_signed_at) : ''],
        ['Home address', l.home_address], ['Next of kin', l.kin_name], ['Kin contact', l.kin_contact]
      ];

      $('#detail-body').innerHTML =
        '<dl>' + fields.filter(function (f) { return f[1]; })
          .map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl>' +
        '<div class="field"><label for="l-link">Tenant link</label><input id="l-link" value="' + esc(link) + '" readonly></div>' +
        (l.tenant_signature ? '<p class="muted">Tenant signature</p><img class="sigimg" src="' + l.tenant_signature + '" alt="Tenant signature">' : '') +
        (l.landlord_signature ? '<p class="muted">Landlord signature</p><img class="sigimg" src="' + l.landlord_signature + '" alt="Landlord signature">' : '') +
        (l.status === 'signed' && canManage()
          ? '<div class="field"><label for="l-sign-name">Counter-sign as</label>' +
            '<input id="l-sign-name" value="' + esc(state.user.name) + '"></div>' +
            '<div class="field"><label for="l-wit1">Witness 1 (optional)</label><input id="l-wit1"></div>' +
            '<div class="field"><label for="l-wit2">Witness 2 (optional)</label><input id="l-wit2"></div>' : '') +
        '<div class="actions">' +
          '<button class="btn btn--ghost btn--sm" id="l-copy" type="button">Copy link</button>' +
          (canManage() && (l.status === 'draft' || l.status === 'sent')
            ? '<button class="btn btn--primary btn--sm" id="l-send" type="button">' +
              (l.status === 'draft' ? 'Send to tenant' : 'Resend link') + '</button>' : '') +
          (canManage() && l.status === 'signed'
            ? '<button class="btn btn--primary btn--sm" id="l-counter" type="button">Counter-sign</button>' : '') +
          '<a class="btn btn--ghost btn--sm" href="' + esc(link) + '" target="_blank" rel="noopener">Open lease</a>' +
          '<a class="btn btn--ghost btn--sm" href="' + API + 'leases/' + l.id + '/pdf" target="_blank" rel="noopener">Download PDF</a>' +
          (canManage() && l.status !== 'cancelled'
            ? '<button class="btn btn--danger btn--sm" id="l-cancel" type="button">Cancel lease</button>' : '') +
        '</div>' +
        '<div id="l-mails"></div>';

      $('#detail').hidden = false;
      mailHistory('#l-mails', l.tenant_email || '', 'leases', l.id);

      $('#l-copy').addEventListener('click', function () {
        $('#l-link').select();
        try { document.execCommand('copy'); toast('Link copied.', 'ok'); }
        catch (e) { toast('Select the link and copy it.', 'err'); }
      });
      if ($('#l-send')) {
        $('#l-send').addEventListener('click', function () {
          api('leases/' + l.id + '/send', { method: 'POST' }).then(function () {
            toast('Lease emailed to the tenant.', 'ok');
            $('#detail').hidden = true;
            state.reloadLeases && state.reloadLeases();
            refreshCounts();
          }).catch(function (e) { toast(e.message, 'err'); });
        });
      }
      if ($('#l-counter')) {
        $('#l-counter').addEventListener('click', function () {
          var name = $('#l-sign-name').value.trim() || state.user.name;
          var c = document.createElement('canvas');
          c.width = 760; c.height = 200;
          var g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.fillStyle = '#1b1410';
          g.font = 'italic 64px "Segoe Script", "Brush Script MT", cursive';
          g.textBaseline = 'middle';
          g.fillText(name, 30, 110);
          api('leases/' + l.id + '/countersign', { method: 'POST', body: {
            signature: c.toDataURL('image/png'), signed_name: name,
            witness_1: ($('#l-wit1') && $('#l-wit1').value.trim()) || '',
            witness_2: ($('#l-wit2') && $('#l-wit2').value.trim()) || ''
          } })
            .then(function () {
              toast('Counter-signed.', 'ok');
              $('#detail').hidden = true;
              state.reloadLeases && state.reloadLeases();
              refreshCounts();
            }).catch(function (e) { toast(e.message, 'err'); });
        });
      }
      if ($('#l-cancel')) {
        $('#l-cancel').addEventListener('click', function () {
          if (!window.confirm('Cancel this lease? The tenant link stops working.')) return;
          api('leases/' + l.id + '/cancel', { method: 'POST' }).then(function () {
            toast('Lease cancelled.', 'ok');
            $('#detail').hidden = true;
            state.reloadLeases && state.reloadLeases();
          }).catch(function (e) { toast(e.message, 'err'); });
        });
      }
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  /* -------------------------------- chats -------------------------------- */
  function renderChats() {
    $('#view-title').textContent = 'Chat transcripts';
    $('#view').innerHTML = '<div class="tablewrap" id="c-table"><p class="empty">Loading…</p></div>';
    api('chat').then(function (d) {
      if (!d.items.length) { $('#c-table').innerHTML = '<p class="empty">No chats yet.</p>'; return; }
      $('#c-table').innerHTML =
        '<table class="data"><thead><tr><th>Started</th><th>Outcome</th><th>Messages</th><th>Session</th></tr></thead><tbody>' +
        d.items.map(function (c, i) {
          return '<tr data-i="' + i + '"><td class="nowrap">' + esc(fmtDate(c.started_at)) + '</td>' +
            '<td>' + badge(c.outcome) + '</td><td>' + esc(c.messages) + '</td>' +
            '<td class="muted">' + esc(c.session_key) + '</td></tr>';
        }).join('') + '</tbody></table>';
      $$('#c-table tbody tr').forEach(function (tr) {
        tr.addEventListener('click', function () { openChat(d.items[Number(tr.dataset.i)]); });
      });
    }).catch(function (e) { $('#c-table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  function openChat(row) {
    $('#detail-title').textContent = 'Chat transcript';
    $('#detail-body').innerHTML = '<p class="empty">Loading…</p>';
    $('#detail').hidden = false;
    api('chat/' + encodeURIComponent(row.session_key)).then(function (d) {
      $('#detail-body').innerHTML = '<div class="transcript">' +
        (d.items.map(function (m) {
          return '<p class="tr tr--' + esc(m.role) + '"><span>' + esc(m.role === 'bot' ? 'Assistant' : 'Student') +
            '</span>' + esc(m.text) + '</p>';
        }).join('') || '<p class="empty">No messages.</p>') + '</div>';
    }).catch(function (e) { $('#detail-body').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  /* ------------------------------- careers ------------------------------- */
  function renderCareers() {
    $('#view-title').textContent = 'Careers';
    $('#view').innerHTML =
      '<div class="panel"><h2>Vacancies</h2><div id="v-list"><p class="empty">Loading…</p></div>' +
        (canManage() ? '<details class="newbox"><summary>Post a vacancy</summary><form id="v-form" class="grid2">' +
          '<div class="field"><label for="v-title">Title</label><input id="v-title" required></div>' +
          '<div class="field"><label for="v-dept">Department</label><input id="v-dept"></div>' +
          '<div class="field"><label for="v-loc">Location</label><input id="v-loc"></div>' +
          '<div class="field"><label for="v-type">Employment type</label><input id="v-type" placeholder="Full time"></div>' +
          '<div class="field" style="grid-column:1/-1"><label for="v-summary">Summary</label><input id="v-summary"></div>' +
          '<div class="field" style="grid-column:1/-1"><label for="v-desc">Description</label><textarea id="v-desc"></textarea></div>' +
          '<div class="field" style="grid-column:1/-1"><label for="v-req">Requirements (one per line)</label><textarea id="v-req"></textarea></div>' +
          '<div class="field"><label>&nbsp;</label><button class="btn btn--primary" type="submit">Post vacancy</button></div>' +
        '</form></details>' : '') +
      '</div>' +
      '<div class="panel"><h2>Job applications</h2><div class="tablewrap" id="j-table"><p class="empty">Loading…</p></div></div>';

    var loadVacancies = function () {
      api('vacancies?all=1').then(function (d) {
        $('#v-list').innerHTML = d.items.length ? d.items.map(function (v) {
          return '<div class="job-row"><div><strong>' + esc(v.title) + '</strong> ' + badge(v.status) +
            '<br><span class="muted">' + esc([v.department, v.location, v.employment_type].filter(Boolean).join(' · ')) + '</span></div>' +
            (canManage() ? '<div class="nowrap">' +
              '<button class="btn btn--ghost btn--sm" data-toggle="' + v.id + '" data-to="' +
              (v.status === 'open' ? 'closed' : 'open') + '">' + (v.status === 'open' ? 'Close' : 'Reopen') + '</button> ' +
              '<button class="btn btn--danger btn--sm" data-del="' + v.id + '">Delete</button></div>' : '') +
            '</div>';
        }).join('') : '<p class="empty">No vacancies posted.</p>';

        $$('#v-list [data-toggle]').forEach(function (b) {
          b.addEventListener('click', function () {
            api('vacancies/' + b.dataset.toggle, { method: 'PATCH', body: { status: b.dataset.to } })
              .then(function () { toast('Saved.', 'ok'); loadVacancies(); })
              .catch(function (e) { toast(e.message, 'err'); });
          });
        });
        $$('#v-list [data-del]').forEach(function (b) {
          b.addEventListener('click', function () {
            if (!window.confirm('Delete this vacancy?')) return;
            api('vacancies/' + b.dataset.del, { method: 'DELETE' })
              .then(function () { toast('Deleted.', 'ok'); loadVacancies(); })
              .catch(function (e) { toast(e.message, 'err'); });
          });
        });
      }).catch(function (e) { $('#v-list').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
    };

    if ($('#v-form')) {
      $('#v-form').addEventListener('submit', function (e) {
        e.preventDefault();
        api('vacancies', { method: 'POST', body: {
          title: $('#v-title').value.trim(), department: $('#v-dept').value.trim(),
          location: $('#v-loc').value.trim(), employment_type: $('#v-type').value.trim(),
          summary: $('#v-summary').value.trim(), description: $('#v-desc').value,
          requirements: $('#v-req').value
        } }).then(function () {
          toast('Vacancy posted.', 'ok');
          $('#v-form').reset();
          loadVacancies();
        }).catch(function (err) { toast(err.message, 'err'); });
      });
    }

    api('job-applications').then(function (d) {
      state.rows.careers = d.items;
      if (!d.items.length) { $('#j-table').innerHTML = '<p class="empty">No applications yet.</p>'; return; }
      $('#j-table').innerHTML =
        '<table class="data"><thead><tr><th>Candidate</th><th>Position</th><th>Email</th><th>Phone</th>' +
        '<th>CV</th><th>Status</th><th>Received</th></tr></thead><tbody>' +
        d.items.map(function (j, i) {
          return '<tr data-i="' + i + '"><td>' + esc(j.name) + '</td><td>' + esc(j.vacancy_title) + '</td>' +
            '<td>' + esc(j.email) + '</td><td>' + esc(j.phone || '—') + '</td>' +
            '<td>' + (j.cv_stored ? 'yes' : '—') + '</td><td>' + badge(j.status) + '</td>' +
            '<td class="nowrap">' + esc(fmtDay(j.created_at)) + '</td></tr>';
        }).join('') + '</tbody></table>';
      $$('#j-table tbody tr').forEach(function (tr) {
        tr.addEventListener('click', function () { openJob(d.items[Number(tr.dataset.i)]); });
      });
    }).catch(function (e) { $('#j-table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });

    loadVacancies();
  }

  function openJob(row) {
    $('#detail-title').textContent = 'Job application';
    var statuses = ['new', 'reviewing', 'shortlisted', 'appointed', 'declined'];
    $('#detail-body').innerHTML =
      '<dl>' + [['Name', row.name], ['Email', row.email], ['Phone', row.phone], ['Position', row.vacancy_title],
                ['Motivation', row.cover_note], ['Received', fmtDate(row.created_at)]]
        .map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1] || '—') + '</dd>'; }).join('') + '</dl>' +
      (row.cv_stored ? '<p><a class="btn btn--ghost btn--sm" href="' + API + 'files/' + encodeURIComponent(row.cv_stored) +
        '" target="_blank" rel="noopener">Open CV</a></p>' : '') +
      '<div class="field"><label for="j-status">Status</label><select id="j-status">' +
        statuses.map(function (s) {
          return '<option value="' + s + '"' + (row.status === s ? ' selected' : '') + '>' + s + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field"><label for="j-notes">Internal notes</label><textarea id="j-notes">' + esc(row.admin_notes || '') + '</textarea></div>' +
      '<div class="actions"><button class="btn btn--primary btn--sm" id="j-save" type="button">Save</button>' +
      '<a class="btn btn--ghost btn--sm" href="mailto:' + esc(row.email) + '">Email</a></div>';
    $('#detail').hidden = false;
    $('#j-save').addEventListener('click', function () {
      api('job-applications/' + row.id, { method: 'PATCH', body: { status: $('#j-status').value, admin_notes: $('#j-notes').value } })
        .then(function () { toast('Saved.', 'ok'); $('#detail').hidden = true; renderCareers(); })
        .catch(function (e) { toast(e.message, 'err'); });
    });
  }

  /* ------------------------------ residences ----------------------------- */
  function renderResidences() {
    $('#view-title').textContent = 'Residences and rates';
    $('#view').innerHTML =
      '<p class="lead">Set what a room costs at each house. New leases fill themselves in from this rate card, and ' +
      'any lease can still be adjusted before it is sent.</p>' +
      '<div class="tablewrap" id="r-table"><p class="empty">Loading…</p></div>';

    Promise.all([api('residences'), api('stats')]).then(function (res) {
      var occ = {};
      res[1].stats.occupancy.forEach(function (o) { occ[o.residence] = o.placed; });
      state.rows.residences = res[0].items;

      $('#r-table').innerHTML =
        '<table class="data rates"><thead><tr><th>Residence</th><th>Capacity</th><th>Placed</th><th>Free</th>' +
        '<th>Single room</th><th>Sharing room</th><th>Deposit</th><th>Admin fee</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' +
        res[0].items.map(function (r) {
          var placed = occ[r.name] || 0;
          var free = Math.max(0, Number(r.capacity) - placed);
          var money = function (field) {
            return '<td><span class="rand">R</span><input class="rate" data-f="' + field + '" data-id="' + r.id +
              '" value="' + esc(r[field] || '') + '" inputmode="decimal" placeholder="—"' +
              (canManage() ? '' : ' disabled') + '></td>';
          };
          return '<tr><td>' + esc(r.name) + '<br><span class="muted">' + esc(r.area || '') + '</span></td>' +
            '<td>' + esc(r.capacity) + '</td><td>' + placed + '</td><td>' + free + '</td>' +
            money('single_rate') + money('sharing_rate') + money('deposit') + money('admin_fee') +
            '<td>' + (canManage()
              ? '<select data-res="' + r.id + '">' + ['open', 'full', 'closed'].map(function (s) {
                  return '<option value="' + s + '"' + (r.status === s ? ' selected' : '') + '>' + s + '</option>';
                }).join('') + '</select>'
              : badge(r.status)) + '</td>' +
            '<td>' + (canManage() ? '<button class="btn btn--primary btn--sm" data-save="' + r.id + '">Save</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';

      $$('#r-table [data-save]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.dataset.save;
          var payload = {};
          $$('#r-table .rate[data-id="' + id + '"]').forEach(function (inp) { payload[inp.dataset.f] = inp.value.trim(); });
          api('residences/' + id, { method: 'PATCH', body: payload })
            .then(function () { toast('Rates saved.', 'ok'); })
            .catch(function (e) { toast(e.message, 'err'); });
        });
      });
      $$('#r-table [data-res]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          api('residences/' + sel.dataset.res, { method: 'PATCH', body: { status: sel.value } })
            .then(function () { toast('Saved.', 'ok'); })
            .catch(function (e) { toast(e.message, 'err'); });
        });
      });
    }).catch(function (e) { $('#r-table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  /* ------------------------------ dashboard ------------------------------ */
  function renderDashboard() {
    $('#view-title').textContent = 'Dashboard';
    $('#view').innerHTML = '<p class="empty">Loading…</p>';

    api('stats').then(function (d) {
      var s = d.stats;
      state.stats = s;

      var occRows = s.occupancy.filter(function (o) { return o.capacity > 0; });
      var occTotal = occRows.reduce(function (a, o) { return a + o.placed; }, 0);

      var occupancy = occRows.map(function (o) {
        var pct = o.capacity ? Math.round((o.placed / o.capacity) * 100) : 0;
        return '<div class="bar"><span>' + esc(o.residence) + '</span><strong>' + o.placed + ' / ' + o.capacity + '</strong>' +
          '<span class="bar__track"><span class="bar__fill' + (pct >= 90 ? ' bar__fill--full' : '') +
          '" style="width:' + Math.min(100, pct) + '%"></span></span></div>';
      }).join('');

      var funders = s.by_funder.map(function (f) {
        var pct = s.applications ? Math.round((f.c / s.applications) * 100) : 0;
        return '<div class="bar"><span>' + esc(f.funder) + '</span><strong>' + f.c + '</strong>' +
          '<span class="bar__track"><span class="bar__fill" style="width:' + pct + '%"></span></span></div>';
      }).join('') || '<p class="empty">No applications yet.</p>';

      var recent = s.recent.length ? s.recent.map(function (r) {
        return '<tr><td>' + esc(r.ref) + '</td><td>' + esc(r.first_name + ' ' + r.last_name) + '</td>' +
          '<td>' + esc(r.residence || 'No preference') + '</td><td><span class="badge">' + esc(r.source) + '</span></td>' +
          '<td>' + badge(r.status) + '</td><td class="nowrap">' + esc(fmtDate(r.created_at)) + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="empty">No applications yet.</td></tr>';

      $('#view').innerHTML =
        '<div class="stats">' +
          stat(s.applications, 'Applications, all time') +
          stat(s.applications_new, 'Awaiting review') +
          stat(s.applications_week, 'Received in 7 days') +
          stat(s.leases_awaiting, 'Leases awaiting signature') +
          stat(s.enquiries_open, 'Open enquiries') +
          stat(s.maintenance_open, 'Open maintenance') +
          stat(occTotal + ' / ' + s.beds, 'Beds placed') +
          stat(s.applications_chat, 'Applied by chat') +
        '</div>' +
        '<div class="grid2">' +
          '<div class="panel"><h2>Occupancy by residence</h2><div class="bars">' + occupancy + '</div>' +
            '<p class="hint">Placed counts applications marked accepted or placed for that residence.</p></div>' +
          '<div class="panel"><h2>Who is funding them</h2><div class="bars">' + funders + '</div>' +
            '<h2 style="margin-top:22px">Where applications stand</h2><div class="bars">' +
            ['new', 'reviewing', 'accepted', 'waitlist', 'placed', 'rejected'].map(function (k) {
              var n = s.by_status[k] || 0;
              return '<div class="bar"><span>' + badge(k) + '</span><strong>' + n + '</strong>' +
                '<span class="bar__track"><span class="bar__fill" style="width:' +
                Math.round((n / Math.max(1, s.applications)) * 100) + '%"></span></span></div>';
            }).join('') + '</div></div>' +
        '</div>' +
        '<div class="panel"><h2>Latest applications</h2><div class="tablewrap"><table class="data"><thead><tr>' +
        '<th>Reference</th><th>Applicant</th><th>Residence</th><th>Via</th><th>Status</th><th>Received</th>' +
        '</tr></thead><tbody>' + recent + '</tbody></table></div></div>';
    }).catch(function (e) { $('#view').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  function stat(n, label) {
    return '<div class="stat"><strong>' + esc(n) + '</strong><span>' + esc(label) + '</span></div>';
  }

  /* -------------------------------- users -------------------------------- */
  function renderUsers() {
    $('#view-title').textContent = 'Staff accounts';
    $('#view').innerHTML =
      '<div class="panel"><h2>Add a staff account</h2>' +
        '<form id="u-form" class="grid2">' +
          '<div class="field"><label for="u-name">Full name</label><input id="u-name" required></div>' +
          '<div class="field"><label for="u-email">Email address</label><input id="u-email" type="email" required></div>' +
          '<div class="field"><label for="u-role">Role</label><select id="u-role">' +
            '<option value="staff">Staff — read and update records</option>' +
            '<option value="manager">Manager — also leases, vacancies, deletes</option>' +
            '<option value="owner">Owner — full access, manages accounts</option>' +
          '</select></div>' +
          '<div class="field"><label>&nbsp;</label><button class="btn btn--primary" type="submit">Add account</button></div>' +
        '</form>' +
        '<p class="hint">New accounts start on the shared temporary password and must change it at first sign-in.</p>' +
      '</div><div class="tablewrap" id="u-table"></div>';

    var load = function () {
      api('users').then(function (d) {
        $('#u-table').innerHTML =
          '<table class="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>' +
          '<th>Last sign-in</th><th>Actions</th></tr></thead><tbody>' +
          d.items.map(function (u) {
            var self = Number(state.user.id) === Number(u.id);
            return '<tr><td>' + esc(u.name) + (self ? ' <span class="badge">you</span>' : '') + '</td>' +
              '<td>' + esc(u.email) + '</td>' +
              '<td>' + (self ? esc(u.role) : '<select data-role="' + u.id + '">' +
                ['owner', 'manager', 'staff'].map(function (r) {
                  return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
                }).join('') + '</select>') + '</td>' +
              '<td>' + (Number(u.active) ? badge('placed') : badge('rejected')) +
                (Number(u.must_change_password) ? ' <span class="badge badge--new">temp password</span>' : '') + '</td>' +
              '<td class="nowrap">' + esc(u.last_login_at ? fmtDate(u.last_login_at) : 'Never') + '</td>' +
              '<td class="nowrap"><button class="btn btn--ghost btn--sm" data-reset="' + u.id + '">Reset password</button> ' +
                (self ? '' : '<button class="btn btn--ghost btn--sm" data-active="' + u.id + '" data-to="' +
                  (Number(u.active) ? 0 : 1) + '">' + (Number(u.active) ? 'Deactivate' : 'Activate') + '</button>') +
              '</td></tr>';
          }).join('') + '</tbody></table>';

        $$('#u-table [data-role]').forEach(function (sel) {
          sel.addEventListener('change', function () {
            api('users/' + sel.dataset.role, { method: 'PATCH', body: { role: sel.value } })
              .then(function () { toast('Role updated.', 'ok'); })
              .catch(function (e) { toast(e.message, 'err'); load(); });
          });
        });
        $$('#u-table [data-reset]').forEach(function (b) {
          b.addEventListener('click', function () {
            if (!window.confirm('Reset this account to the shared temporary password?')) return;
            api('users/' + b.dataset.reset + '/reset', { method: 'POST' })
              .then(function () { toast('Password reset.', 'ok'); load(); })
              .catch(function (e) { toast(e.message, 'err'); });
          });
        });
        $$('#u-table [data-active]').forEach(function (b) {
          b.addEventListener('click', function () {
            api('users/' + b.dataset.active, { method: 'PATCH', body: { active: Number(b.dataset.to) } })
              .then(function () { toast('Saved.', 'ok'); load(); })
              .catch(function (e) { toast(e.message, 'err'); });
          });
        });
      }).catch(function (e) { $('#u-table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
    };

    $('#u-form').addEventListener('submit', function (e) {
      e.preventDefault();
      api('users', { method: 'POST', body: {
        name: $('#u-name').value.trim(), email: $('#u-email').value.trim(), role: $('#u-role').value
      } }).then(function (d) { toast(d.message, 'ok'); $('#u-form').reset(); load(); })
        .catch(function (err) { toast(err.message, 'err'); });
    });
    load();
  }

  function renderActivity() {
    $('#view-title').textContent = 'Activity log';
    $('#view').innerHTML = '<div class="tablewrap" id="a-table"><p class="empty">Loading…</p></div>';
    api('audit').then(function (d) {
      $('#a-table').innerHTML = '<table class="data"><thead><tr><th>When</th><th>Who</th><th>Action</th>' +
        '<th>Detail</th></tr></thead><tbody>' +
        (d.items.map(function (r) {
          return '<tr><td class="nowrap">' + esc(fmtDate(r.at)) + '</td><td>' + esc(r.user_email) +
            '</td><td>' + esc(r.action) + '</td><td>' + esc(r.detail) + '</td></tr>';
        }).join('') || '<tr><td colspan="4" class="empty">Nothing logged yet.</td></tr>') + '</tbody></table>';
    }).catch(function (e) { $('#a-table').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  /* -------------------------------- routing ------------------------------ */
  function refreshCounts() {
    api('today').then(function (d) {
      var t = d.tiles;
      $('#pill-today').textContent = d.items.length;
      $('#pill-apps').textContent = t.awaiting_review;
      $('#pill-mnt').textContent = t.open_maintenance;
      $('#pill-cxl').textContent = t.cancellations_open;
      $('#pill-rev').textContent = t.reviews_new;
      $('#pill-ret').textContent = t.retentions_new;
      $('#pill-leases').textContent = t.leases_countersign;
      $('#pill-fin').textContent = t.refunds_open + t.invoices_overdue;
      $('#pill-stf').textContent = t.staff_requests_new;
    }).catch(function () {});
    api('stats').then(function (d) {
      $('#pill-enq').textContent = d.stats.enquiries_open;
    }).catch(function () {});
  }

  function route() {
    if (!state.user) return;
    var parts = (location.hash || '#/today').replace('#/', '').split('/');
    var key = parts[0];
    var sub = parts[1] || '';
    $$('[data-nav]').forEach(function (a) { a.classList.toggle('is-on', a.dataset.nav === key); });
    $('#detail').hidden = true;
    $('#side').classList.remove('is-open');

    if (key === 'today') renderToday();
    else if (key === 'finance') renderFinance();
    else if (key === 'messages') renderMessages(sub);
    else if (key === 'reviews') renderReviews();
    else if (VIEWS[key]) renderList(key);
    else if (key === 'leases') renderLeases();
    else if (key === 'chats') renderChats();
    else if (key === 'careers') renderCareers();
    else if (key === 'residences') renderResidences();
    else if (key === 'users' && isOwner()) renderUsers();
    else if (key === 'activity' && isOwner()) renderActivity();
    else if (key === 'dashboard') renderDashboard();
    else renderToday();

    refreshCounts();
  }

  window.addEventListener('hashchange', route);

  api('auth/me').then(function (d) { afterAuth(d.user); }).catch(function () { showLogin(); });
})();

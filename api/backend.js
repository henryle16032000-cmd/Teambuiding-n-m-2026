const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// =========================================================================
// TIỆN ÍCH DÙNG CHUNG
// =========================================================================
const DEFAULT_TIME_CONFIG = {
  startTimeMs: new Date('2026-11-03T15:00:00+07:00').getTime(),
  durationMs: 2 * 60 * 60 * 1000
};

const DEFAULT_BROADCAST = {
  active: false,
  level: 'info',
  message: '',
  updatedAt: 0
};

const DEFAULT_BRIEFING = {
  locationTitle: 'Sân chính ĐH Y Dược TP.HCM (217 Hồng Bàng)',
  locationDesc: 'Có mặt điểm danh trước giờ xuất phát 15 phút để nhận vật phẩm đội.',
  items: [
    '🔋 Điện thoại sạc đầy pin, sạc dự phòng & bật sẵn 4G + GPS.',
    '👟 Trang phục gọn gàng, giày thể thao, nón và bình nước cá nhân.',
    '🎫 Tiền lẻ / thẻ đi xe buýt, Metro và thẻ sinh viên (nếu cần).'
  ],
  notice: '⚡ Lưu ý: Cổng giải mật thư Trạm 1 sẽ tự động mở và tính giờ ngay khi đồng hồ đếm ngược khai mạc!'
};

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatTimeMs(ms) {
  const safe = Math.max(0, Math.floor(Number(ms) || 0));
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatSignedTimeMs(ms) {
  const val = Math.round(Number(ms) || 0);
  const sign = val < 0 ? '-' : '+';
  return sign + formatTimeMs(Math.abs(val));
}

function parseTimeStrToMs(str) {
  const parts = String(str || '').trim().split(':').map(Number);
  if (parts.length === 3 && parts.every(n => !isNaN(n))) {
    return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
  }
  return 0;
}

function formatVNTime(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d);
}

function formatVNDateTime(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const time = formatVNTime(d);
  const date = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(d);
  return `${time} ${date}`;
}

function parseGpsString(gpsStr) {
  if (!gpsStr) return { hasGps: false, lat: 0, lng: 0 };
  const match = String(gpsStr).match(/Lat:\s*(-?\d+(?:\.\d+)?)\s*,\s*Lon:\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) return { hasGps: false, lat: 0, lng: 0 };
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) {
    return { hasGps: false, lat: 0, lng: 0 };
  }
  return { hasGps: true, lat, lng };
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function norm(val) {
  return String(val || '').trim();
}

function normUpper(val) {
  return norm(val).toUpperCase();
}

function maskEmail(email) {
  const s = norm(email);
  const idx = s.indexOf('@');
  if (idx <= 2) return s;
  return s.slice(0, 2) + '***' + s.slice(idx);
}

async function appendAuditLog(actorRole, actorId, targetTeam, action, detail) {
  try {
    await supabase.from('audit_logs').insert({
      actor_role: norm(actorRole),
      actor_id: norm(actorId),
      target_team: norm(targetTeam),
      action: norm(action),
      detail: norm(detail)
    });
  } catch (e) {}
}

// =========================================================================
// CÀI ĐẶT HỆ THỐNG (system_settings)
// =========================================================================
async function getSettingsMap() {
  const { data } = await supabase.from('system_settings').select('key, value');
  const map = {};
  (data || []).forEach(row => {
    map[row.key] = row.value;
  });

  const tc = map.time_config || DEFAULT_TIME_CONFIG;
  const startTimeMs = Number(tc.startTimeMs) || DEFAULT_TIME_CONFIG.startTimeMs;
  const durationMs = Number(tc.durationMs) || DEFAULT_TIME_CONFIG.durationMs;
  const serverNow = Date.now();

  let eventPhase = 'live';
  if (startTimeMs > 0 && serverNow < startTimeMs) eventPhase = 'pre';
  else if (startTimeMs > 0 && durationMs > 0 && serverNow >= startTimeMs + durationMs) eventPhase = 'post';

  return {
    serverNow,
    eventStartTimeMs: startTimeMs,
    eventDurationMs: durationMs,
    eventPhase,
    resultsPublished: map.results_published === true || map.results_published === 'true',
    broadcast: map.broadcast || DEFAULT_BROADCAST,
    briefing: map.briefing || DEFAULT_BRIEFING
  };
}

async function setSetting(key, value) {
  const { error } = await supabase
    .from('system_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}

// =========================================================================
// HÀM ĐỌC DỮ LIỆU CHUNG (stations, team_progress, checkins)
// =========================================================================
async function getStationsMap() {
  const { data } = await supabase.from('stations').select('*');
  const map = {};
  (data || []).forEach(st => {
    map[normUpper(st.code)] = {
      code: norm(st.code),
      name: norm(st.name),
      lat: Number(st.lat) || 0,
      lng: Number(st.lng) || 0,
      password: norm(st.password),
      hint: norm(st.hint),
      steps: Array.isArray(st.steps) ? st.steps : [],
      prep: norm(st.prep),
      par_minutes: Number(st.par_minutes) || 0
    };
  });
  return map;
}

async function getTeamProgressRow(teamId) {
  const { data } = await supabase
    .from('team_progress')
    .select('*')
    .ilike('team_id', norm(teamId))
    .limit(1);
  return (data && data[0]) || null;
}

async function getTeamCheckin(teamId, stationCode) {
  if (!teamId || !stationCode) return null;
  const { data } = await supabase
    .from('checkins')
    .select('*')
    .ilike('team_id', norm(teamId))
    .ilike('station_code', norm(stationCode))
    .limit(1);
  return (data && data[0]) || null;
}

function getRouteArray(tp) {
  if (!tp || !Array.isArray(tp.route)) return [];
  return tp.route.map(s => norm(s)).filter(Boolean);
}

function getCurrentStationCode(tp) {
  const route = getRouteArray(tp);
  if (route.length === 0) return '';
  const idx = Math.max(0, Math.min(route.length - 1, Number(tp.current_station_idx) || 0));
  return route[idx];
}

function computeLiveTimerMs(tp, nowMs) {
  const base = Number(tp.timer_elapsed_ms) || 0;
  if (tp.timer_status === 'running' && Number(tp.timer_started_at) > 0) {
    return base + Math.max(0, nowMs - Number(tp.timer_started_at));
  }
  return base;
}

function computeCipherElapsedMs(tp, meta) {
  if (meta.eventPhase === 'pre') return 0;
  const now = meta.serverNow;
  const rawStart = Number(tp.cipher_started_at) || 0;
  const effectiveStart =
    rawStart > 0
      ? Math.max(rawStart, meta.eventStartTimeMs || 0)
      : meta.eventStartTimeMs > 0
      ? meta.eventStartTimeMs
      : now;
  const base = Math.max(0, now - effectiveStart);
  const penalty = tp.cipher_hint_used ? 180000 : 0;
  return base + penalty;
}

function buildLeaderboard(teamsList, stationsMap) {
  const rows = (teamsList || []).map(tp => {
    const route = getRouteArray(tp);
    const results = tp.station_results && typeof tp.station_results === 'object' ? tp.station_results : {};
    let totalStationMs = 0;
    let totalCipherDeltaMs = 0;
    let ciphersSolved = 0;
    let hintsUsedCount = 0;
    let finishedCount = 0;

    const currCode = getCurrentStationCode(tp);

    const routeDetails = route.map((stCode, idx) => {
      const r = results[stCode] || results[normUpper(stCode)] || {};
      const stInfo = stationsMap[normUpper(stCode)];
      const isFinished = r.status === 'finished';
      if (isFinished) {
        finishedCount++;
        totalStationMs += Number(r.timeMs) || parseTimeStrToMs(r.timeStr);
      }

      if (r.cipherSolved) {
        ciphersSolved++;
        totalCipherDeltaMs += Number(r.cipherDeltaMs) || 0;
      }
      if (r.cipherHintUsed) {
        hintsUsedCount++;
      }

      let status = 'pending';
      if (isFinished) status = 'finished';
      else if (idx === Number(tp.current_station_idx) && tp.timer_status === 'running') status = 'running';

      const timeStr = isFinished ? (r.timeStr || formatTimeMs(r.timeMs)) : '--:--:--';
      let cipherDeltaStr = '';
      if (r.cipherSolved) {
        cipherDeltaStr = r.cipherDeltaStr || formatSignedTimeMs(r.cipherDeltaMs || 0);
      } else if (stInfo && !stInfo.password && isFinished) {
        cipherDeltaStr = '';
      }

      return {
        station: stCode,
        status,
        timeStr,
        cipherDeltaStr,
        cipherHintUsed: !!r.cipherHintUsed
      };
    });

    const progress = Math.max(finishedCount, Number(tp.completed_count) || 0);
    const rankingScoreMs = totalStationMs + totalCipherDeltaMs;
    const hasActivity = progress > 0 || ciphersSolved > 0;

    return {
      id: norm(tp.team_id),
      progress,
      ciphersSolved,
      hintsUsedCount,
      totalTimeMs: totalStationMs,
      totalTimeStr: formatTimeMs(totalStationMs),
      totalCipherDeltaMs,
      totalCipherDeltaStr: ciphersSolved > 0 ? formatSignedTimeMs(totalCipherDeltaMs) : '00:00:00',
      rankingScoreMs,
      rankingScoreStr: hasActivity
        ? (rankingScoreMs < 0 ? '-' + formatTimeMs(Math.abs(rankingScoreMs)) : formatTimeMs(rankingScoreMs))
        : '--:--:--',
      route: routeDetails
    };
  });

  // Sắp xếp: Trạm (giảm) -> Mật thư (giảm) -> Giờ quy đổi (tăng) -> Ít gợi ý (tăng) -> Tên đội
  rows.sort((a, b) => {
    if (b.progress !== a.progress) return b.progress - a.progress;
    if (b.ciphersSolved !== a.ciphersSolved) return b.ciphersSolved - a.ciphersSolved;
    const aHas = a.progress > 0 || a.ciphersSolved > 0;
    const bHas = b.progress > 0 || b.ciphersSolved > 0;
    if (aHas && bHas && a.rankingScoreMs !== b.rankingScoreMs) {
      return a.rankingScoreMs - b.rankingScoreMs;
    }
    if (a.hintsUsedCount !== b.hintsUsedCount) return a.hintsUsedCount - b.hintsUsedCount;
    return a.id.localeCompare(b.id, 'vi');
  });

  return rows;
}

// =========================================================================
// CHỐT CHẶN CTV TRƯỚC GIỜ G / HẾT GIỜ / MẬT THƯ / CHƯA CHECK-IN
// =========================================================================
async function enforceCtvTimeGuard(action, args) {
  const guarded = [
    'startTeamStationTime',
    'pauseTeamStationTime',
    'resumeTeamStationTime',
    'finishTeamStationTime',
    'sendNextStationChallenge'
  ];
  if (!guarded.includes(action)) return null;

  const meta = await getSettingsMap();
  if (meta.eventPhase === 'pre') {
    return {
      success: false,
      code: 'BEFORE_START',
      eventPhase: 'pre',
      message: '⏳ Hiện chưa bắt đầu chương trình, không thể tính giờ bắt đầu.'
    };
  }
  if (meta.eventPhase === 'post') {
    return {
      success: false,
      code: 'EVENT_ENDED',
      eventPhase: 'post',
      message: '🚨 Chương trình đã kết thúc! Mọi thao tác bấm giờ đã bị khóa.'
    };
  }

  if (action === 'startTeamStationTime' && args.length >= 2) {
    const [teamId, stationCode] = args;
    const tp = await getTeamProgressRow(teamId);
    if (!tp) {
      return { success: false, message: 'Không tìm thấy tiến độ của đội này!' };
    }
    if (normUpper(tp.lock_status) === 'LOCKED') {
      return {
        success: false,
        code: 'CIPHER_LOCKED',
        message: '🔒 Đội này đang giải mật thư, chưa mở khóa lộ trình đến trạm nên không thể bắt đầu tính giờ!'
      };
    }
    const ck = await getTeamCheckin(teamId, stationCode);
    if (!ck) {
      return {
        success: false,
        code: 'NOT_CHECKED_IN',
        message: '📸 Đội chưa xác nhận đã đến trạm & chụp ảnh lưu niệm! Vui lòng nhắc nhở đội ấn xác nhận tới trạm trước khi bắt đầu.'
      };
    }
  }

  return null;
}

// =========================================================================
// CÁC HÀM XỬ LÝ CHÍNH (KHỚP 100% TÊN HÀM TRONG index.html)
// =========================================================================

// 1. Thời gian & Bảng công khai
async function getGlobalTimeSettings() {
  const meta = await getSettingsMap();
  return {
    success: true,
    startTimeMs: meta.eventStartTimeMs,
    durationMs: meta.eventDurationMs,
    serverNow: meta.serverNow
  };
}

async function updateGlobalTimeSettings(newStartTimeMs, newDurationMs) {
  const startMs = Number(newStartTimeMs);
  const durMs = Number(newDurationMs);
  if (!startMs || !durMs || durMs <= 0) {
    return { success: false, message: 'Thời gian bắt đầu hoặc thời lượng không hợp lệ!' };
  }

  await setSetting('time_config', { startTimeMs: startMs, durationMs: durMs });
  await setSetting('results_published', false);

  const stationsMap = await getStationsMap();
  const { data: allTeams } = await supabase.from('team_progress').select('*');

  for (const tp of allTeams || []) {
    const route = getRouteArray(tp);
    const firstSt = route[0] ? stationsMap[normUpper(route[0])] : null;
    const initialLock = firstSt && !firstSt.password ? 'UNLOCKED' : 'LOCKED';
    await supabase
      .from('team_progress')
      .update({
        current_station_idx: 0,
        completed_count: 0,
        lock_status: initialLock,
        timer_status: 'travel',
        timer_started_at: 0,
        timer_elapsed_ms: 0,
        station_results: {},
        cipher_started_at: 0,
        cipher_hint_used: false,
        updated_at: new Date().toISOString()
      })
      .eq('team_id', tp.team_id);
  }

  // Xóa lịch sử check-in & gỡ cờ SOS
  await supabase.from('checkins').delete().neq('id', -1);
  await supabase.from('students').update({ is_sos: false }).eq('is_sos', true);
  await appendAuditLog('QTV', 'QTV-001', 'ALL', 'RESET_SYSTEM_TIME', `Start=${formatVNDateTime(startMs)}, Dur=${Math.round(durMs / 60000)}m`);

  return {
    success: true,
    message: 'Đã cập nhật thời gian và Reset toàn bộ hệ thống về trạng thái ban đầu!'
  };
}

async function getGlobalStats() {
  const { data: allTeams } = await supabase.from('team_progress').select('current_station_idx, completed_count');
  const counts = [0, 0, 0, 0, 0];
  const list = allTeams || [];
  list.forEach(tp => {
    const done = Number(tp.completed_count) || 0;
    if (done < 5) {
      const idx = Math.max(0, Math.min(4, Number(tp.current_station_idx) || 0));
      counts[idx]++;
    }
  });
  return {
    success: true,
    totalTeams: list.length,
    counts
  };
}

async function getPublicCommState() {
  const meta = await getSettingsMap();
  return {
    success: true,
    broadcast: meta.broadcast,
    briefing: meta.briefing
  };
}

async function getPublicEventBoard() {
  const meta = await getSettingsMap();
  const { data: allTeams } = await supabase.from('team_progress').select('*');
  let leaderboard = [];
  if (meta.eventPhase === 'post' && meta.resultsPublished) {
    const stationsMap = await getStationsMap();
    leaderboard = buildLeaderboard(allTeams, stationsMap);
  }
  return {
    success: true,
    serverNow: meta.serverNow,
    startTimeMs: meta.eventStartTimeMs,
    durationMs: meta.eventDurationMs,
    phase: meta.eventPhase,
    published: meta.resultsPublished,
    teamCount: (allTeams || []).length,
    leaderboard,
    broadcast: meta.broadcast,
    briefing: meta.briefing
  };
}

// 2. Đăng nhập bảo mật (SV & CTV/QTV)
async function buildStudentSessionPayload(student) {
  const meta = await getSettingsMap();
  const stationsMap = await getStationsMap();
  const tp = await getTeamProgressRow(student.team_id);

  if (!tp) {
    return { success: false, message: `Đội ${student.team_id} chưa được cấu hình lộ trình trong hệ thống!` };
  }

  const currCode = getCurrentStationCode(tp);
  const st = stationsMap[normUpper(currCode)] || {
    code: currCode,
    name: currCode,
    lat: 0,
    lng: 0,
    steps: [],
    prep: ''
  };

  const ck = await getTeamCheckin(student.team_id, currCode);

  let uiLockKey = 'SV_NAV';
  if (meta.eventPhase === 'post') uiLockKey = 'SV_ENDGAME';
  else if (meta.eventPhase === 'pre') uiLockKey = 'SV_PRE';
  else if (normUpper(tp.lock_status) === 'LOCKED') uiLockKey = 'SV_CIPHER';
  else if (tp.timer_status === 'finished') uiLockKey = 'SV_WAIT_NEXT';

  return {
    success: true,
    teamId: student.team_id,
    mssv: student.mssv,
    name: student.full_name,
    isLeader: !!student.is_leader,
    progress: Number(tp.completed_count) || 0,
    lockStatus: normUpper(tp.lock_status) || 'LOCKED',
    isWaitingForChallenge: tp.timer_status === 'finished',
    station: {
      code: st.code,
      name: st.name,
      lat: st.lat,
      lng: st.lng,
      steps: st.steps,
      prep: st.prep
    },
    hasCheckedIn: !!ck,
    checkinTime: ck ? formatVNDateTime(ck.created_at) : '',
    checkinPhotoUrl: ck ? ck.photo_url : '',
    uiLockKey,
    eventPhase: meta.eventPhase,
    serverNow: meta.serverNow,
    eventStartTimeMs: meta.eventStartTimeMs,
    eventDurationMs: meta.eventDurationMs,
    broadcast: meta.broadcast,
    briefing: meta.briefing
  };
}

async function loginStudentSecure(mssv, password) {
  const cleanMssv = norm(mssv);
  const cleanPass = norm(password);
  if (!cleanMssv || !cleanPass) {
    return { success: false, message: 'Vui lòng nhập đầy đủ MSSV và Mật khẩu!' };
  }

  const { data } = await supabase.from('students').select('*').ilike('mssv', cleanMssv).limit(1);
  const student = data && data[0];
  if (!student) {
    return { success: false, message: '❌ Không tìm thấy MSSV này trong danh sách tham gia!' };
  }

  const savedPass = norm(student.password);
  const isValid = savedPass ? savedPass === cleanPass : cleanPass.toUpperCase() === normUpper(student.mssv);
  if (!isValid) {
    return { success: false, message: '❌ Mật khẩu không chính xác! (Nếu chưa đổi, mật khẩu mặc định là MSSV).' };
  }

  return await buildStudentSessionPayload(student);
}

async function checkStudentLogin(teamId, mssv) {
  const { data } = await supabase.from('students').select('*').ilike('mssv', norm(mssv)).limit(1);
  const student = data && data[0];
  if (!student || (teamId && normUpper(student.team_id) !== normUpper(teamId))) {
    return { success: false, message: 'Không tìm thấy thông tin sinh viên!' };
  }
  return await buildStudentSessionPayload(student);
}

async function loginAdminSecure(maAdmin, phoneAdmin, passAdmin) {
  const cleanCode = norm(maAdmin);
  const cleanPhone = norm(phoneAdmin).replace(/\s+/g, '');
  const cleanPass = norm(passAdmin);

  if (!cleanCode || !cleanPhone || !cleanPass) {
    return { success: false, message: 'Vui lòng nhập đầy đủ Mã tài khoản, SĐT và Mật khẩu!' };
  }

  const { data } = await supabase.from('staff').select('*').ilike('code', cleanCode).limit(1);
  const staff = data && data[0];
  if (!staff) {
    return { success: false, message: '❌ Không tìm thấy Mã tài khoản Ban Quản trị!' };
  }

  const savedPhone = norm(staff.phone).replace(/\s+/g, '');
  if (savedPhone !== cleanPhone) {
    return { success: false, message: '❌ Số điện thoại không khớp với tài khoản này!' };
  }

  const savedPass = norm(staff.password);
  const isValid = savedPass
    ? savedPass === cleanPass
    : cleanPass === savedPhone || normUpper(cleanPass) === normUpper(staff.code);

  if (!isValid) {
    return { success: false, message: '❌ Mật khẩu không chính xác!' };
  }

  const meta = await getSettingsMap();
  const idType = normUpper(staff.id_type) === 'QTV' ? 'QTV' : 'CTV';
  const uiLockKey = idType === 'CTV' && meta.eventPhase === 'post' ? 'CTV_ENDGAME' : 'CTV_ACTIVE';

  return {
    success: true,
    maAdmin: staff.code,
    name: staff.full_name,
    mssv: staff.mssv,
    role: staff.role_assign,
    idType,
    uiLockKey,
    eventPhase: meta.eventPhase,
    serverNow: meta.serverNow,
    eventStartTimeMs: meta.eventStartTimeMs,
    eventDurationMs: meta.eventDurationMs,
    broadcast: meta.broadcast,
    briefing: meta.briefing
  };
}

// 3. Đổi mật khẩu & Quên mật khẩu (OTP Email via Gmail)
async function changeUserPassword(role, accId, oldPass, newPass) {
  const cleanId = norm(accId);
  const cleanOld = norm(oldPass);
  const cleanNew = norm(newPass);
  if (cleanNew.length < 4) {
    return { success: false, message: 'Mật khẩu mới cần tối thiểu 4 ký tự!' };
  }

  if (role === 'student') {
    const { data } = await supabase.from('students').select('*').ilike('mssv', cleanId).limit(1);
    const st = data && data[0];
    if (!st) return { success: false, message: 'Không tìm thấy tài khoản sinh viên!' };
    const saved = norm(st.password);
    const ok = saved ? saved === cleanOld : cleanOld.toUpperCase() === normUpper(st.mssv);
    if (!ok) return { success: false, message: 'Mật khẩu hiện tại không đúng!' };

    await supabase.from('students').update({ password: cleanNew, updated_at: new Date().toISOString() }).eq('id', st.id);
    await appendAuditLog('SV', st.mssv, st.team_id, 'CHANGE_PASSWORD', 'Đổi mật khẩu thành công');
    return { success: true, message: '✅ Đã đổi mật khẩu thành công!' };
  } else {
    const { data } = await supabase.from('staff').select('*').ilike('code', cleanId).limit(1);
    const st = data && data[0];
    if (!st) return { success: false, message: 'Không tìm thấy tài khoản Ban Quản trị!' };
    const saved = norm(st.password);
    const savedPhone = norm(st.phone).replace(/\s+/g, '');
    const ok = saved ? saved === cleanOld : cleanOld === savedPhone || normUpper(cleanOld) === normUpper(st.code);
    if (!ok) return { success: false, message: 'Mật khẩu hiện tại không đúng!' };

    await supabase.from('staff').update({ password: cleanNew, updated_at: new Date().toISOString() }).eq('code', st.code);
    await appendAuditLog(st.id_type, st.code, '', 'CHANGE_PASSWORD', 'Đổi mật khẩu thành công');
    return { success: true, message: '✅ Đã đổi mật khẩu thành công!' };
  }
}

async function requestPasswordOtp(role, accId, phone) {
  const cleanId = norm(accId);
  const cleanPhone = norm(phone).replace(/\s+/g, '');
  let email = '';
  let displayName = '';

  if (role === 'student') {
    const { data } = await supabase.from('students').select('*').ilike('mssv', cleanId).limit(1);
    const st = data && data[0];
    if (!st) return { success: false, message: 'Không tìm thấy MSSV trong hệ thống!' };
    email = norm(st.email);
    displayName = st.full_name;
  } else {
    const { data } = await supabase.from('staff').select('*').ilike('code', cleanId).limit(1);
    const st = data && data[0];
    if (!st) return { success: false, message: 'Không tìm thấy Mã tài khoản trong hệ thống!' };
    if (norm(st.phone).replace(/\s+/g, '') !== cleanPhone) {
      return { success: false, message: 'Số điện thoại xác minh không khớp!' };
    }
    email = norm(st.email);
    displayName = st.full_name;
  }

  if (!email || !email.includes('@')) {
    return {
      success: false,
      message: 'Tài khoản này chưa đăng ký địa chỉ Email! Vui lòng liên hệ Ban Tổ chức để được cấp lại mật khẩu.'
    };
  }

  const gmailUser = norm(process.env.GMAIL_USER);
  const gmailPass = norm(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '');
  if (!gmailUser || !gmailPass) {
    return { success: false, message: 'Hệ thống chưa cấu hình email gửi OTP (GMAIL_USER / GMAIL_APP_PASSWORD).' };
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const cacheKey = `${role}:${normUpper(cleanId)}`;
  const expiresAt = Date.now() + 5 * 60 * 1000;

  await supabase.from('otp_codes').upsert({ cache_key: cacheKey, otp_code: otp, expires_at: expiresAt }, { onConflict: 'cache_key' });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass }
  });

  await transporter.sendMail({
    from: `"TEAMBUILDING UMP 2026" <${gmailUser}>`,
    to: email,
    subject: '[TEAMBUILDING UMP 2026] Mã OTP khôi phục mật khẩu',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #0284c7; margin-top: 0;">KHÔI PHỤC MẬT KHẨU</h2>
        <p>Xin chào <strong>${displayName}</strong> (${cleanId}),</p>
        <p>Mã OTP xác thực đặt lại mật khẩu của bạn là:</p>
        <div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #0f172a; background: #f0f9ff; padding: 14px; text-align: center; border-radius: 10px; border: 1px dashed #0284c7;">
          ${otp}
        </div>
        <p style="font-size: 13px; color: #64748b; margin-top: 14px;">Mã có hiệu lực trong <strong>5 phút</strong>. Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email này.</p>
      </div>
    `
  });

  return {
    success: true,
    message: `📧 Mã OTP 6 số đã được gửi tới email ${maskEmail(email)} (hiệu lực 5 phút).`
  };
}

async function verifyOtpAndResetPassword(role, accId, otpInput, newPass) {
  const cleanId = norm(accId);
  const cleanOtp = norm(otpInput);
  const cleanNew = norm(newPass);
  if (cleanNew.length < 4) {
    return { success: false, message: 'Mật khẩu mới cần tối thiểu 4 ký tự!' };
  }

  const cacheKey = `${role}:${normUpper(cleanId)}`;
  const { data } = await supabase.from('otp_codes').select('*').eq('cache_key', cacheKey).limit(1);
  const row = data && data[0];

  if (!row || row.otp_code !== cleanOtp) {
    return { success: false, message: '❌ Mã OTP không chính xác!' };
  }
  if (Date.now() > Number(row.expires_at)) {
    await supabase.from('otp_codes').delete().eq('cache_key', cacheKey);
    return { success: false, message: '⏳ Mã OTP đã hết hạn! Vui lòng yêu cầu gửi lại mã mới.' };
  }

  if (role === 'student') {
    await supabase.from('students').update({ password: cleanNew, updated_at: new Date().toISOString() }).ilike('mssv', cleanId);
  } else {
    await supabase.from('staff').update({ password: cleanNew, updated_at: new Date().toISOString() }).ilike('code', cleanId);
  }

  await supabase.from('otp_codes').delete().eq('cache_key', cacheKey);
  await appendAuditLog(role.toUpperCase(), cleanId, '', 'RESET_PASSWORD_OTP', 'Khôi phục mật khẩu bằng OTP');

  return { success: true, message: '✅ Đặt lại mật khẩu thành công! Bạn có thể đăng nhập ngay.' };
}

// 4. Polling Sinh viên, Giải Mật thư, Gợi ý, GPS & Check-in Ảnh
async function getStudentTimerStatus(teamId, stationCode) {
  const meta = await getSettingsMap();
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };

  const actualStCode = getCurrentStationCode(tp);
  if (stationCode && actualStCode && normUpper(actualStCode) !== normUpper(stationCode)) {
    return {
      success: true,
      status: 'force_reload',
      serverNow: meta.serverNow,
      eventStartTimeMs: meta.eventStartTimeMs,
      eventDurationMs: meta.eventDurationMs,
      eventPhase: meta.eventPhase,
      broadcast: meta.broadcast
    };
  }

  const stationsMap = await getStationsMap();
  const st = stationsMap[normUpper(actualStCode)] || { code: actualStCode, hint: '', par_minutes: 0 };
  const ck = await getTeamCheckin(tp.team_id, actualStCode);

  const elapsedMs = computeLiveTimerMs(tp, meta.serverNow);
  const isLocked = normUpper(tp.lock_status) === 'LOCKED';

  let cipher = null;
  if (isLocked) {
    cipher = {
      stationCode: actualStCode,
      isBeforeStart: meta.eventPhase === 'pre',
      hasHint: !!st.hint,
      hintUsed: !!tp.cipher_hint_used,
      hintText: tp.cipher_hint_used ? st.hint : '',
      penaltyMs: 180000,
      totalElapsedMs: computeCipherElapsedMs(tp, meta)
    };
  }

  return {
    success: true,
    status: tp.timer_status || 'travel',
    elapsedMs,
    timeStr: formatTimeMs(elapsedMs),
    lockStatus: isLocked ? 'LOCKED' : 'UNLOCKED',
    isBeforeStart: meta.eventPhase === 'pre',
    eventPhase: meta.eventPhase,
    serverNow: meta.serverNow,
    eventStartTimeMs: meta.eventStartTimeMs,
    eventDurationMs: meta.eventDurationMs,
    broadcast: meta.broadcast,
    hasCheckedIn: !!ck,
    checkinTime: ck ? formatVNDateTime(ck.created_at) : '',
    checkinPhotoUrl: ck ? ck.photo_url : '',
    cipher
  };
}

async function requestStationHint(teamId, stationCode) {
  const meta = await getSettingsMap();
  if (meta.eventPhase === 'pre') return { success: false, message: '⏳ Chưa đến giờ khai mạc!' };
  if (meta.eventPhase === 'post') return { success: false, message: '🚨 Chương trình đã kết thúc!' };

  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };

  const currCode = getCurrentStationCode(tp);
  const targetCode = norm(stationCode) || currCode;
  const stationsMap = await getStationsMap();
  const st = stationsMap[normUpper(targetCode)];
  if (!st || !st.hint) {
    return { success: false, message: 'Trạm này hiện không có gợi ý mật thư!' };
  }

  if (tp.cipher_hint_used) {
    return {
      success: true,
      alreadyUsed: true,
      hintText: st.hint,
      penaltyMs: 180000,
      totalElapsedMs: computeCipherElapsedMs(tp, meta)
    };
  }

  const cipherStart = Number(tp.cipher_started_at) > 0 ? Number(tp.cipher_started_at) : (meta.eventStartTimeMs || meta.serverNow);
  await supabase
    .from('team_progress')
    .update({
      cipher_hint_used: true,
      cipher_started_at: cipherStart,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('SV', tp.team_id, tp.team_id, 'USE_HINT', `Dùng gợi ý mật thư ${targetCode} (+180s)`);

  const updatedTp = { ...tp, cipher_hint_used: true, cipher_started_at: cipherStart };
  return {
    success: true,
    alreadyUsed: false,
    hintText: st.hint,
    penaltyMs: 180000,
    totalElapsedMs: computeCipherElapsedMs(updatedTp, meta)
  };
}

async function verifyStationPassword(teamId, stationCode, inputVal) {
  const meta = await getSettingsMap();
  if (meta.eventPhase === 'pre') return { success: false, message: '⏳ Chưa đến giờ khai mạc chương trình!' };
  if (meta.eventPhase === 'post') return { success: false, message: '🚨 Chương trình đã kết thúc!' };

  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội chơi!' };

  const currCode = getCurrentStationCode(tp);
  const targetCode = norm(stationCode) || currCode;
  const stationsMap = await getStationsMap();
  const st = stationsMap[normUpper(targetCode)];
  if (!st) return { success: false, message: 'Không tìm thấy thông tin trạm!' };

  const expected = norm(st.password).replace(/\s+/g, ' ').toUpperCase();
  const actual = norm(inputVal).replace(/\s+/g, ' ').toUpperCase();

  if (expected && actual !== expected) {
    return { success: false, message: '❌ Đáp án mật thư chưa chính xác! Kiểm tra lại nhé.' };
  }

  const cipherElapsedMs = computeCipherElapsedMs(tp, meta);
  const parMs = (Number(st.par_minutes) || 0) * 60 * 1000;
  const cipherDeltaMs = cipherElapsedMs - parMs;
  const cipherDeltaStr = formatSignedTimeMs(cipherDeltaMs);

  const results = tp.station_results && typeof tp.station_results === 'object' ? { ...tp.station_results } : {};
  const prevStRes = results[currCode] || {};
  results[currCode] = {
    ...prevStRes,
    cipherSolved: true,
    cipherElapsedMs,
    cipherParMs: parMs,
    cipherDeltaMs,
    cipherDeltaStr,
    cipherHintUsed: !!tp.cipher_hint_used
  };

  await supabase
    .from('team_progress')
    .update({
      lock_status: 'UNLOCKED',
      timer_status: 'travel',
      station_results: results,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('SV', tp.team_id, tp.team_id, 'UNLOCK_CIPHER', `Giải xong mật thư ${currCode} (Δ=${cipherDeltaStr})`);
  return { success: true, message: '🎉 Chính xác! Tọa độ trạm đã được mở khóa!' };
}

async function updateGPSInBackground(id, mssv, gpsStr, roleType) {
  const cleanGps = norm(gpsStr);
  if (!cleanGps) return { success: false };

  if (roleType === 'admin') {
    await supabase
      .from('staff')
      .update({ gps: cleanGps, updated_at: new Date().toISOString() })
      .ilike('code', norm(id));
  } else {
    const isSos = cleanGps.toUpperCase().includes('[SOS]');
    const updatePayload = { gps: cleanGps, updated_at: new Date().toISOString() };
    if (isSos) updatePayload.is_sos = true;
    await supabase.from('students').update(updatePayload).ilike('mssv', norm(mssv));
    if (isSos) {
      await appendAuditLog('SV', mssv, id, 'SOS_TRIGGERED', cleanGps);
    }
  }
  return { success: true };
}

async function submitStationCheckinPhoto(teamId, mssv, stationCode, base64Data) {
  const cleanTeam = norm(teamId);
  const cleanSt = norm(stationCode);
  const cleanMssv = norm(mssv);
  if (!cleanTeam || !cleanSt) {
    return { success: false, message: 'Thiếu thông tin đội hoặc mã trạm!' };
  }

  const meta = await getSettingsMap();
  if (meta.eventPhase === 'pre') return { success: false, message: '⏳ Chưa đến giờ khai mạc chương trình!' };
  if (meta.eventPhase === 'post') return { success: false, message: '🚨 Chương trình đã kết thúc!' };

  const existing = await getTeamCheckin(cleanTeam, cleanSt);
  if (existing) {
    return {
      success: true,
      alreadyCheckedIn: true,
      checkinTime: formatVNDateTime(existing.created_at),
      photoUrl: existing.photo_url,
      message: '✅ Đội bạn đã xác nhận đến trạm trước đó rồi!'
    };
  }

  if (!base64Data || !String(base64Data).includes('base64,')) {
    return { success: false, message: 'Vui lòng chụp ảnh lưu niệm trước khi gửi!' };
  }

  const parts = String(base64Data).split('base64,');
  const mimeMatch = parts[0].match(/data:(.*?);/);
  const contentType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const buffer = Buffer.from(parts[1], 'base64');

  const safeTeam = cleanTeam.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeSt = cleanSt.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = `${safeTeam}/${safeSt}_${Date.now()}.jpg`;

  const { error: uploadErr } = await supabase.storage
    .from('checkin-photos')
    .upload(filePath, buffer, { contentType, upsert: true });

  if (uploadErr) {
    return { success: false, message: 'Lỗi tải ảnh lên kho lưu trữ: ' + uploadErr.message };
  }

  const { data: pubData } = supabase.storage.from('checkin-photos').getPublicUrl(filePath);
  const photoUrl = pubData ? pubData.publicUrl : '';
  const nowIso = new Date().toISOString();

  await supabase.from('checkins').upsert(
    {
      team_id: cleanTeam,
      station_code: cleanSt,
      sender_mssv: cleanMssv,
      photo_url: photoUrl,
      created_at: nowIso
    },
    { onConflict: 'team_id,station_code' }
  );

  await appendAuditLog('SV', cleanMssv || cleanTeam, cleanTeam, 'CHECKIN_TRAM', `Xác nhận đến ${cleanSt}: ${photoUrl}`);

  return {
    success: true,
    alreadyCheckedIn: false,
    checkinTime: formatVNDateTime(nowIso),
    photoUrl,
    message: `📸 Đã gửi ảnh lưu niệm & xác nhận đến ${cleanSt} thành công!`
  };
}

// 5. Các hàm cho CTV (Trưởng trạm)
async function getAllTeamsList() {
  const { data } = await supabase.from('team_progress').select('team_id').order('team_id', { ascending: true });
  return {
    success: true,
    teams: (data || []).map(r => r.team_id)
  };
}

async function getProximityTeamsForStation(stationCode) {
  const targetCode = normUpper(stationCode);
  const stationsMap = await getStationsMap();
  const st = stationsMap[targetCode];
  if (!st) return { success: true, teams: [] };

  const [{ data: allTeams }, { data: allStudents }, { data: allCheckins }] = await Promise.all([
    supabase.from('team_progress').select('*'),
    supabase.from('students').select('team_id, gps, is_leader, updated_at'),
    supabase.from('checkins').select('*').ilike('station_code', targetCode)
  ]);

  const gpsByTeam = {};
  (allStudents || []).forEach(s => {
    const key = normUpper(s.team_id);
    const parsed = parseGpsString(s.gps);
    if (!parsed.hasGps) return;
    if (!gpsByTeam[key] || s.is_leader) {
      gpsByTeam[key] = parsed;
    }
  });

  const ckByTeam = {};
  (allCheckins || []).forEach(c => {
    ckByTeam[normUpper(c.team_id)] = c;
  });

  const result = [];
  (allTeams || []).forEach(tp => {
    const currCode = normUpper(getCurrentStationCode(tp));
    const progress = Number(tp.completed_count) || 0;
    const isLocked = normUpper(tp.lock_status) === 'LOCKED';

    // CHỈ hiện đội đang di chuyển tới hoặc đang chơi tại đúng trạm này (ẩn triệt để đội đang giải mật thư hoặc đã xong 5/5)
    if (currCode !== targetCode) return;
    if (progress >= 5) return;
    if (isLocked) return;

    const teamKey = normUpper(tp.team_id);
    const teamGps = gpsByTeam[teamKey];
    let dist = 999;
    if (teamGps && teamGps.hasGps && st.lat && st.lng) {
      dist = getDistanceKm(teamGps.lat, teamGps.lng, st.lat, st.lng);
    }

    const ck = ckByTeam[teamKey];
    result.push({
      teamId: tp.team_id,
      dist,
      timerStatus: tp.timer_status || 'travel',
      hasCheckedIn: !!ck,
      checkinTime: ck ? formatVNTime(ck.created_at) : ''
    });
  });

  result.sort((a, b) => {
    const rank = t => (t.timerStatus === 'running' ? 0 : t.hasCheckedIn ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.dist - b.dist;
  });

  return { success: true, teams: result };
}

async function getTeamProgressForCTV(teamId, stationCode) {
  const meta = await getSettingsMap();
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội chơi này!' };

  const route = getRouteArray(tp);
  const targetUp = normUpper(stationCode);
  const foundIdx = route.findIndex(r => normUpper(r) === targetUp);
  const currCode = getCurrentStationCode(tp);
  const stationsMap = await getStationsMap();
  const currStObj = stationsMap[normUpper(currCode)];

  const foundInRoute = foundIdx !== -1;
  const progress = Number(tp.completed_count) || 0;
  const isAllDone = progress >= route.length && route.length > 0;
  const isWrongStation = foundInRoute && normUpper(currCode) !== targetUp;
  const isCipherLocked = !isWrongStation && normUpper(tp.lock_status) === 'LOCKED';

  const results = tp.station_results && typeof tp.station_results === 'object' ? tp.station_results : {};
  const stRes = results[currCode] || results[targetUp] || {};
  const hasFinishedCurrent = !isWrongStation && (tp.timer_status === 'finished' || stRes.status === 'finished');

  const ck = await getTeamCheckin(tp.team_id, stationCode);
  const elapsedMs = hasFinishedCurrent
    ? Number(stRes.timeMs) || Number(tp.timer_elapsed_ms) || 0
    : computeLiveTimerMs(tp, meta.serverNow);

  const timerStatus =
    tp.timer_status === 'running' || tp.timer_status === 'paused' || tp.timer_status === 'finished'
      ? tp.timer_status
      : 'idle';

  return {
    success: true,
    teamId: tp.team_id,
    progress,
    foundInRoute,
    isWrongStation,
    currentStationText: isAllDone
      ? 'Đã hoàn thành 5/5 trạm'
      : currStObj
      ? `${currStObj.code} (${currStObj.name})`
      : currCode,
    isCipherLocked,
    hasFinishedCurrent,
    timerState: {
      status: timerStatus,
      elapsedMs
    },
    hasCheckedIn: !!ck,
    checkinTime: ck ? formatVNDateTime(ck.created_at) : '',
    checkinPhotoUrl: ck ? ck.photo_url : '',
    serverNow: meta.serverNow,
    eventStartTimeMs: meta.eventStartTimeMs,
    eventDurationMs: meta.eventDurationMs,
    eventPhase: meta.eventPhase
  };
}

async function startTeamStationTime(teamId, stationCode) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };
  if (normUpper(getCurrentStationCode(tp)) !== normUpper(stationCode)) {
    return { success: false, message: 'Đội này hiện không ở trạm của bạn!' };
  }
  if (tp.timer_status === 'finished') {
    return { success: false, message: 'Đội đã hoàn thành trạm này rồi!' };
  }

  await supabase
    .from('team_progress')
    .update({
      timer_status: 'running',
      timer_started_at: Date.now(),
      timer_elapsed_ms: 0,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('CTV', stationCode, tp.team_id, 'START_TIMER', `Bắt đầu tính giờ tại ${stationCode}`);
  return { success: true };
}

async function pauseTeamStationTime(teamId, stationCode, elapsedMs) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false };
  const safeMs = Math.max(0, Number(elapsedMs) || computeLiveTimerMs(tp, Date.now()));

  await supabase
    .from('team_progress')
    .update({
      timer_status: 'paused',
      timer_started_at: 0,
      timer_elapsed_ms: safeMs,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('CTV', stationCode, tp.team_id, 'PAUSE_TIMER', `Tạm dừng tại ${formatTimeMs(safeMs)}`);
  return { success: true };
}

async function resumeTeamStationTime(teamId, stationCode, elapsedMs) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false };
  const safeMs = Math.max(0, Number(elapsedMs) || Number(tp.timer_elapsed_ms) || 0);

  await supabase
    .from('team_progress')
    .update({
      timer_status: 'running',
      timer_started_at: Date.now(),
      timer_elapsed_ms: safeMs,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('CTV', stationCode, tp.team_id, 'RESUME_TIMER', `Tiếp tục từ ${formatTimeMs(safeMs)}`);
  return { success: true };
}

async function finishTeamStationTime(teamId, stationCode, finalTimeStr) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };

  const currCode = getCurrentStationCode(tp);
  const ms = parseTimeStrToMs(finalTimeStr) || computeLiveTimerMs(tp, Date.now());
  const cleanStr = finalTimeStr || formatTimeMs(ms);

  const results = tp.station_results && typeof tp.station_results === 'object' ? { ...tp.station_results } : {};
  const prev = results[currCode] || {};
  results[currCode] = {
    ...prev,
    status: 'finished',
    timeStr: cleanStr,
    timeMs: ms
  };

  const route = getRouteArray(tp);
  const completedCount = route.filter(r => results[r] && results[r].status === 'finished').length;

  await supabase
    .from('team_progress')
    .update({
      completed_count: completedCount,
      timer_status: 'finished',
      timer_started_at: 0,
      timer_elapsed_ms: ms,
      station_results: results,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('CTV', stationCode, tp.team_id, 'FINISH_STATION', `Hoàn thành ${currCode}: ${cleanStr}`);
  return { success: true, message: `Đã lưu thành tích ${cleanStr}` };
}

async function sendNextStationChallenge(teamId, stationCode) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };

  const route = getRouteArray(tp);
  const nextIdx = (Number(tp.current_station_idx) || 0) + 1;

  if (nextIdx >= route.length) {
    return { success: true, message: `Đội ${tp.team_id} đã hoàn thành toàn bộ ${route.length} trạm!` };
  }

  const nextCode = route[nextIdx];
  const stationsMap = await getStationsMap();
  const nextSt = stationsMap[normUpper(nextCode)];
  const nextLock = nextSt && !nextSt.password ? 'UNLOCKED' : 'LOCKED';

  await supabase
    .from('team_progress')
    .update({
      current_station_idx: nextIdx,
      lock_status: nextLock,
      timer_status: 'travel',
      timer_started_at: 0,
      timer_elapsed_ms: 0,
      cipher_started_at: Date.now(),
      cipher_hint_used: false,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('CTV', stationCode, tp.team_id, 'SEND_NEXT_STATION', `Chuyển đội sang ${nextCode}`);
  return { success: true, message: `Đã gửi thử thách trạm tiếp theo (${nextCode}) cho đội ${tp.team_id}!` };
}

// 6. Các hàm Điều hành QTV (All & QTV-001)
async function getQTVDashboardData() {
  const [meta, stationsMap, teamsRes, studentsRes, staffRes] = await Promise.all([
    getSettingsMap(),
    getStationsMap(),
    supabase.from('team_progress').select('*').order('team_id', { ascending: true }),
    supabase.from('students').select('*'),
    supabase.from('staff').select('*')
  ]);

  const allTeams = teamsRes.data || [];
  const allStudents = studentsRes.data || [];
  const allStaff = staffRes.data || [];

  // Tổng hợp thông tin thành viên, GPS & SOS theo đội
  const teamMemberMap = {};
  const sosList = [];

  allStudents.forEach(s => {
    const tKey = normUpper(s.team_id);
    if (!teamMemberMap[tKey]) {
      teamMemberMap[tKey] = { leaderName: s.full_name, hasGps: false, lat: 0, lng: 0, isSOS: false };
    }
    const parsed = parseGpsString(s.gps);
    if (s.is_leader) {
      teamMemberMap[tKey].leaderName = s.full_name;
      if (parsed.hasGps) {
        teamMemberMap[tKey].hasGps = true;
        teamMemberMap[tKey].lat = parsed.lat;
        teamMemberMap[tKey].lng = parsed.lng;
      }
    } else if (!teamMemberMap[tKey].hasGps && parsed.hasGps) {
      teamMemberMap[tKey].hasGps = true;
      teamMemberMap[tKey].lat = parsed.lat;
      teamMemberMap[tKey].lng = parsed.lng;
    }

    const isMemberSos = !!s.is_sos || normUpper(s.gps).includes('[SOS]');
    if (isMemberSos) {
      teamMemberMap[tKey].isSOS = true;
      sosList.push({
        teamId: s.team_id,
        name: s.full_name,
        mssv: s.mssv,
        isLeader: !!s.is_leader,
        rawGps: norm(s.gps) || 'Chưa có tọa độ',
        hasGps: parsed.hasGps,
        lat: parsed.lat,
        lng: parsed.lng
      });
    }
  });

  // CTV list
  const ctvs = allStaff
    .filter(st => normUpper(st.id_type) === 'CTV')
    .map(c => {
      const parsed = parseGpsString(c.gps);
      return {
        id: c.code,
        name: c.full_name,
        phone: c.phone,
        role: c.role_assign,
        hasGps: parsed.hasGps,
        lat: parsed.lat,
        lng: parsed.lng
      };
    });

  // Teams list & teamsByStation
  const teamsByStation = {};
  const usedStationCodes = new Set();

  const teams = allTeams.map(tp => {
    const route = getRouteArray(tp);
    route.forEach(r => usedStationCodes.add(normUpper(r)));

    const currCode = getCurrentStationCode(tp);
    const currSt = stationsMap[normUpper(currCode)] || { code: currCode, name: currCode, lat: 0, lng: 0 };
    const mInfo = teamMemberMap[normUpper(tp.team_id)] || { leaderName: '---', hasGps: false, lat: 0, lng: 0, isSOS: false };
    const progress = Number(tp.completed_count) || 0;

    if (progress < route.length) {
      const stKey = normUpper(currCode);
      if (!teamsByStation[stKey]) teamsByStation[stKey] = [];
      teamsByStation[stKey].push({
        id: tp.team_id,
        status: tp.timer_status || 'travel',
        lockStatus: normUpper(tp.lock_status) || 'LOCKED'
      });
    }

    return {
      id: tp.team_id,
      leaderName: mInfo.leaderName,
      currentStation: currCode,
      currentStationName: currSt.name,
      progress,
      lockStatus: normUpper(tp.lock_status) || 'LOCKED',
      timerStatus: tp.timer_status || 'travel',
      hasNextStation: (Number(tp.current_station_idx) || 0) < route.length - 1,
      isSOS: mInfo.isSOS,
      hasGps: mInfo.hasGps,
      lat: mInfo.hasGps ? mInfo.lat : currSt.lat,
      lng: mInfo.hasGps ? mInfo.lng : currSt.lng
    };
  });

  // Stations grid (chỉ hiện các trạm có tọa độ, có CTV hoặc nằm trong lộ trình)
  const stations = Object.values(stationsMap)
    .map(st => {
      const stKey = normUpper(st.code);
      const stCtvs = ctvs.filter(c => normUpper(c.role) === stKey);
      const stTeams = teamsByStation[stKey] || [];
      return {
        code: st.code,
        name: st.name,
        lat: st.lat,
        lng: st.lng,
        hasPassword: !!st.password,
        teamsHere: stTeams,
        ctvs: stCtvs
      };
    })
    .filter(st => st.lat !== 0 || st.lng !== 0 || st.ctvs.length > 0 || usedStationCodes.has(normUpper(st.code)))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const leaderboard = buildLeaderboard(allTeams, stationsMap);

  return {
    success: true,
    updatedAt: formatVNTime(new Date()),
    resultsPublished: meta.resultsPublished,
    broadcast: meta.broadcast,
    briefing: meta.briefing,
    teams,
    stations,
    ctvs,
    sosList,
    leaderboard
  };
}

async function qtvUnlockTeam(teamId) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };

  const currCode = getCurrentStationCode(tp);
  const results = tp.station_results && typeof tp.station_results === 'object' ? { ...tp.station_results } : {};
  const prev = results[currCode] || {};
  results[currCode] = {
    ...prev,
    cipherSolved: true,
    cipherDeltaMs: prev.cipherDeltaMs || 0,
    cipherDeltaStr: prev.cipherDeltaStr || '+00:00:00',
    cipherHintUsed: !!tp.cipher_hint_used
  };

  await supabase
    .from('team_progress')
    .update({
      lock_status: 'UNLOCKED',
      timer_status: 'travel',
      station_results: results,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('QTV', 'QTV', tp.team_id, 'QTV_UNLOCK', `Mở khóa hộ mật thư ${currCode}`);
  return { success: true, message: `🔓 Đã mở khóa mật thư hộ đội ${tp.team_id}!` };
}

async function qtvForceNextStation(teamId) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };

  const route = getRouteArray(tp);
  const nextIdx = (Number(tp.current_station_idx) || 0) + 1;
  if (nextIdx >= route.length) {
    return { success: false, message: `Đội ${tp.team_id} đang ở trạm cuối cùng rồi!` };
  }

  const nextCode = route[nextIdx];
  const stationsMap = await getStationsMap();
  const nextSt = stationsMap[normUpper(nextCode)];
  const nextLock = nextSt && !nextSt.password ? 'UNLOCKED' : 'LOCKED';

  await supabase
    .from('team_progress')
    .update({
      current_station_idx: nextIdx,
      lock_status: nextLock,
      timer_status: 'travel',
      timer_started_at: 0,
      timer_elapsed_ms: 0,
      cipher_started_at: Date.now(),
      cipher_hint_used: false,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await appendAuditLog('QTV', 'QTV', tp.team_id, 'QTV_FORCE_NEXT', `Chuyển thẳng đội sang ${nextCode}`);
  return { success: true, message: `⏭️ Đã chuyển đội ${tp.team_id} sang ${nextCode}!` };
}

async function qtvResetSingleTeam(teamId) {
  const tp = await getTeamProgressRow(teamId);
  if (!tp) return { success: false, message: 'Không tìm thấy đội!' };

  const route = getRouteArray(tp);
  const stationsMap = await getStationsMap();
  const firstSt = route[0] ? stationsMap[normUpper(route[0])] : null;
  const initialLock = firstSt && !firstSt.password ? 'UNLOCKED' : 'LOCKED';

  await supabase
    .from('team_progress')
    .update({
      current_station_idx: 0,
      completed_count: 0,
      lock_status: initialLock,
      timer_status: 'travel',
      timer_started_at: 0,
      timer_elapsed_ms: 0,
      station_results: {},
      cipher_started_at: 0,
      cipher_hint_used: false,
      updated_at: new Date().toISOString()
    })
    .eq('team_id', tp.team_id);

  await supabase.from('checkins').delete().ilike('team_id', tp.team_id);
  await appendAuditLog('QTV', 'QTV', tp.team_id, 'QTV_RESET_TEAM', 'Reset toàn bộ tiến độ & check-in đội');
  return { success: true, message: `♻️ Đã Reset toàn bộ dữ liệu đội ${tp.team_id} về Trạm 1!` };
}

async function qtvResolveSOS(teamId, mssv) {
  let query = supabase.from('students').select('id, gps');
  if (norm(mssv)) query = query.ilike('mssv', norm(mssv));
  else query = query.ilike('team_id', norm(teamId));

  const { data } = await query;
  for (const row of data || []) {
    const cleanedGps = norm(row.gps).replace(/\s*\[SOS\]/gi, '').trim();
    await supabase.from('students').update({ is_sos: false, gps: cleanedGps }).eq('id', row.id);
  }

  await appendAuditLog('QTV', 'QTV', teamId, 'QTV_RESOLVE_SOS', `Gỡ báo động SOS (${mssv || teamId})`);
  return { success: true, message: `✅ Đã xác nhận xử lý SOS cho đội ${teamId}!` };
}

async function qtvSetResultsPublished(adminId, isPublished) {
  if (normUpper(adminId) !== 'QTV-001') {
    return { success: false, message: 'Chỉ tài khoản QTV-001 mới được phép công bố kết quả!' };
  }
  const state = !!isPublished;
  await setSetting('results_published', state);
  await appendAuditLog('QTV', adminId, 'ALL', 'TOGGLE_PUBLISH_RESULTS', state ? 'Công bố kết quả' : 'Ẩn kết quả');
  return {
    success: true,
    published: state,
    message: state ? '🎉 Đã CÔNG BỐ Bảng xếp hạng chính thức!' : '🔒 Đã phủ kính ẩn lại kết quả!'
  };
}

async function qtvSaveBroadcast(adminId, active, level, message) {
  if (normUpper(adminId) !== 'QTV-001') {
    return { success: false, message: 'Chỉ tài khoản QTV-001 mới được phép phát sóng!' };
  }
  const payload = {
    active: !!active,
    level: ['info', 'warn', 'urgent'].includes(level) ? level : 'info',
    message: norm(message),
    updatedAt: Date.now()
  };
  await setSetting('broadcast', payload);
  await appendAuditLog('QTV', adminId, 'ALL', 'BROADCAST', payload.active ? `[${payload.level}] ${payload.message}` : 'Tắt banner');
  return {
    success: true,
    broadcast: payload,
    message: payload.active ? '📢 Đã phát sóng thông báo toàn hệ thống!' : '🔇 Đã tắt banner thông báo!'
  };
}

async function qtvSaveBriefing(adminId, briefingObj) {
  if (normUpper(adminId) !== 'QTV-001') {
    return { success: false, message: 'Chỉ tài khoản QTV-001 mới được phép sửa nội dung dặn dò!' };
  }
  const payload = {
    locationTitle: norm(briefingObj && briefingObj.locationTitle),
    locationDesc: norm(briefingObj && briefingObj.locationDesc),
    items: Array.isArray(briefingObj && briefingObj.items) ? briefingObj.items.map(norm).filter(Boolean) : [],
    notice: norm(briefingObj && briefingObj.notice)
  };
  await setSetting('briefing', payload);
  await appendAuditLog('QTV', adminId, 'ALL', 'UPDATE_BRIEFING', payload.locationTitle);
  return {
    success: true,
    briefing: payload,
    message: '💾 Đã lưu nội dung dặn dò trước giờ G!'
  };
}

// =========================================================================
// ROUTER CHÍNH CHO VERCEL API (/api/backend)
// =========================================================================
const HANDLERS = {
  getGlobalTimeSettings,
  updateGlobalTimeSettings,
  getGlobalStats,
  getPublicCommState,
  getPublicEventBoard,
  loginStudentSecure,
  checkStudentLogin,
  loginAdminSecure,
  changeUserPassword,
  requestPasswordOtp,
  verifyOtpAndResetPassword,
  getStudentTimerStatus,
  requestStationHint,
  verifyStationPassword,
  updateGPSInBackground,
  submitStationCheckinPhoto,
  getAllTeamsList,
  getProximityTeamsForStation,
  getTeamProgressForCTV,
  startTeamStationTime,
  pauseTeamStationTime,
  resumeTeamStationTime,
  finishTeamStationTime,
  sendNextStationChallenge,
  getQTVDashboardData,
  qtvUnlockTeam,
  qtvForceNextStation,
  qtvResetSingleTeam,
  qtvResolveSOS,
  qtvSetResultsPublished,
  qtvSaveBroadcast,
  qtvSaveBriefing
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Teambuilding UMP 2026 Vercel API is running!' });
  }

  try {
    if (!supabaseUrl || !supabaseKey) {
      return res.status(200).json({
        ok: false,
        error: 'Chưa cấu hình SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trên Vercel!'
      });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = norm(body.action);
    const args = Array.isArray(body.args) ? body.args : [];

    if (!action || typeof HANDLERS[action] !== 'function') {
      return res.status(200).json({ ok: false, error: `Hành động không tồn tại: ${action}` });
    }

    const guardErr = await enforceCtvTimeGuard(action, args);
    if (guardErr) {
      return res.status(200).json({ ok: true, data: guardErr });
    }

    const data = await HANDLERS[action](...args);
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error('Backend API Error:', err);
    return res.status(200).json({ ok: false, error: err.message || String(err) });
  }
};

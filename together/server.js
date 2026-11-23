// 益起出發 Together For better — 後端伺服器
// 只用 Node.js 內建模組，不需要 npm install。
// 啟動方式：雙擊「start-windows.bat」或「start-mac.command」，或在這個資料夾執行 node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { spawn } = require('child_process');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const GRANTS_FILE = path.join(DATA_DIR, 'grants.json');
// 帳號、登入、訂閱等使用者資料的存放位置。部署到雲端時可設定 STORAGE_DIR 指到永久磁碟
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : DATA_DIR;
fs.mkdirSync(STORAGE_DIR, { recursive: true });
const SESSION_DAYS = 30;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// 在自己電腦上只開給本機（127.0.0.1）：不會跳 Windows 防火牆、同網路的人也連不進來。
// 雲端主機會給 PORT 或 HOST，才開放給外部。
const HOST = process.env.HOST || (process.env.PORT || IS_PRODUCTION ? '0.0.0.0' : '127.0.0.1');
// node server.js --share：同時開一條 Cloudflare 臨時通道，產生可以給別人點的網址
const SHARE = process.argv.includes('--share');

const TRACKER_STATUSES = ['想申請', '準備中', '已送件', '已錄取', '未錄取'];

// 依資料 id 的前綴分組（例如 TW-01 → TW）
const GROUPS = {
  TW: { label: '台灣補助與競賽', icon: 'fa-landmark', cover: 'from-navy-900 via-navy-800 to-sky-600' },
  SCH: { label: '獎助學金', icon: 'fa-hand-holding-heart', cover: 'from-sky-600 via-blue-800 to-navy-950' },
  ESG: { label: '永續淨零', icon: 'fa-leaf', cover: 'from-teal-700 via-sky-800 to-navy-900' },
  GL: { label: '國際資源', icon: 'fa-earth-americas', cover: 'from-blue-800 via-indigo-900 to-navy-950' },
  BH: { label: '競賽類別彙整', icon: 'fa-trophy', cover: 'from-cyan-700 via-sky-800 to-navy-950' },
};
// 資金性質：這幾種類型不是「無償現金」
const CASH_BY_TYPE = { 非現金資源: 'noncash', 榮譽獎項: 'noncash', 股權投資: 'equity' };
const CASH_LABELS = { grant: '無償獎助（現金）', noncash: '非現金／榮譽', equity: '股權投資（非無償）' };

const OTHER_GROUP = { label: '其他', icon: 'fa-circle-info', cover: 'from-sky-700 via-blue-800 to-navy-900' };

// ======================================================================
// 1. 檔案存取（JSON 檔當資料庫）
// ======================================================================

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    console.error(`讀取 data/${name} 失敗：`, err.message);
    throw err;
  }
}

function writeJson(name, data) {
  const file = path.join(STORAGE_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // 先寫暫存檔再改名，避免寫到一半當機把檔案弄壞
}

// 使用者、登入狀態等資料常駐記憶體，有變動就寫回檔案
const db = {
  users: readJson('users.json', []),
  sessions: readJson('sessions.json', {}),
  subscribers: readJson('subscribers.json', []),
  inquiries: readJson('host-inquiries.json', []),
};
const DB_FILES = { users: 'users.json', sessions: 'sessions.json', subscribers: 'subscribers.json', inquiries: 'host-inquiries.json' };
const save = (name) => writeJson(DB_FILES[name], db[name]);

// ======================================================================
// 2. 獎助資料（data/grants.json）
//    檔案被修改時會自動重新載入，不用重開伺服器
// ======================================================================

let grantsCache = { mtimeMs: -1, list: [], byId: new Map() };

const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

function safeUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

// 接受 2026-11-30 或 2026-11-30T12:00:00+08:00，統一成日期
const validDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

// 從說明文字取出某一段，例如「資金性質：雲端額度」→「雲端額度」
function descField(description, labels) {
  for (const part of description.split('｜')) {
    const t = part.trim();
    for (const label of labels) if (t.startsWith(label + '：')) return t.slice(label.length + 1).trim();
  }
  return '';
}

function normalizeGrant(g, index) {
  const id = String(g.id || `ITEM-${index + 1}`);
  const prefix = id.split('-')[0];
  // 可以在資料裡用 group 指定分類；沒指定就看 id 前綴
  const groupKey = GROUPS[g.group] ? g.group : prefix;
  const group = GROUPS[groupKey] ? groupKey : 'OTHER';
  const groupInfo = GROUPS[groupKey] || OTHER_GROUP;
  const amount = g.amountMax === null || g.amountMax === undefined || g.amountMax === '' ? null : Number(g.amountMax);
  return {
    id,
    order: index,
    name: String(g.name || '（未命名）'),
    organization: String(g.organization || ''),
    fundingType: String(g.fundingType || '其他'),
    category: String(g.category || ''),
    fields: asList(g.fields),
    applicants: asList(g.applicants),
    identities: asList(g.identities),
    regions: asList(g.regions),
    stages: asList(g.stages),
    expenses: asList(g.expenses),
    years: asList(g.years),
    amountMax: amount === null || !Number.isFinite(amount) ? null : amount, // null = 金額依個別規定
    payoutTiming: String(g.payoutTiming || '未確認'),
    deadline: validDate(g.deadline),
    deadlineNote: String(g.deadlineNote || (g.deadline && !validDate(g.deadline) ? g.deadline : '') || ''),
    fundingTypeDetail: String(g.fundingTypeDetail || ''),
    applicantsDetail: asList(g.applicantsDetail),
    identitiesDetail: asList(g.identitiesDetail),
    regionsDetail: asList(g.regionsDetail),
    expensesDetail: asList(g.expensesDetail),
    schools: asList(g.schools),
    description: String(g.description || ''),
    url: safeUrl(g.url),
    verifiedAt: validDate(g.verifiedAt),
    cash: ['grant', 'noncash', 'equity'].includes(g.cashNature) ? g.cashNature : CASH_BY_TYPE[String(g.fundingType || '')] || 'grant',
    isCategory: id.startsWith('BH-') || String(g.description || '').includes('此筆為競賽類別彙整'),
    approx: String(g.description || '').includes('約當台幣'),
    nature: descField(String(g.description || ''), ['資金性質', '性質']),
    group,
    groupLabel: groupInfo.label,
    icon: groupInfo.icon,
    coverBg: groupInfo.cover,
  };
}

function getGrants() {
  const { mtimeMs } = fs.statSync(GRANTS_FILE);
  if (mtimeMs !== grantsCache.mtimeMs) {
    try {
      const raw = JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('最外層必須是 [ ] 陣列');
      const list = raw.map(normalizeGrant);
      const seen = new Set();
      for (const g of list) {
        if (seen.has(g.id)) console.warn(`⚠ 有重複的 id「${g.id}」，請改成不一樣的編號`);
        seen.add(g.id);
      }
      grantsCache = { mtimeMs, list, byId: new Map(list.map((g) => [g.id, g])) };
      console.log(`已載入 ${list.length} 筆獎助資料`);
    } catch (err) {
      // 第一次啟動就讀不到，直接讓伺服器停下來；之後改壞了，就先沿用上一版資料
      if (grantsCache.mtimeMs === -1) throw err;
      grantsCache.mtimeMs = mtimeMs; // 同一個壞檔不要每次都重讀
      console.error('\n⚠ data/grants.json 格式有錯，網站先繼續使用上一版資料。');
      console.error(`  錯誤訊息：${err.message}`);
      console.error('  常見原因：少了逗號、多了逗號（最後一筆後面不能有逗號）、引號沒有成對。修好存檔後會自動重新載入。\n');
    }
  }
  return grantsCache;
}

function todayTaipei() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function daysLeft(deadline) {
  if (!deadline) return null;
  const today = new Date(todayTaipei() + 'T00:00:00+08:00');
  const end = new Date(deadline + 'T00:00:00+08:00');
  return Math.round((end - today) / 86400000);
}

// 金額要依資金性質用不同說法，避免非現金資源看起來像現金獎金
function amountInfo(g) {
  const known = g.amountMax !== null;
  const n = known ? 'NT$ ' + g.amountMax.toLocaleString('en-US') : '';
  const amt = (g.approx ? '約 ' : '') + n;
  const unknownText = '金額依個別規定';
  if (g.isCategory) {
    return g.amountMax
      ? { amountTitle: '這類比賽常見獎金上限', amountShort: `常見上限 ${n}`, amountLong: `${n}（各賽事不同）` }
      : { amountTitle: '獎金', amountShort: '依各賽事公告', amountLong: '依各賽事公告' };
  }
  if (g.fundingType === '榮譽獎項') {
    return g.amountMax
      ? { amountTitle: '相關獎勵', amountShort: `榮譽獎・獎勵最高 ${amt}`, amountLong: `以榮譽為主，相關獎勵最高 ${amt}` }
      : { amountTitle: '獎金', amountShort: '無獎金（榮譽表揚）', amountLong: '無獎金，以榮譽表揚為主' };
  }
  if (g.cash === 'noncash') {
    const what = g.fundingType === '非現金資源' ? '資源' : '獎品';
    return g.amountMax
      ? { amountTitle: `${what}價值（非現金）`, amountShort: `非現金・價值 ${amt}`, amountLong: `價值 ${amt}（不是現金）` }
      : { amountTitle: what, amountShort: `非現金${what}`, amountLong: `非現金${what}，內容依計畫安排` };
  }
  if (g.cash === 'equity') {
    return { amountTitle: '投資金額（需出讓股權）', amountShort: known ? `股權投資・${amt}` : '股權投資', amountLong: known ? `${amt}（股權投資，不是無償補助）` : '股權投資，不是無償補助' };
  }
  if (!known) return { amountTitle: '最高金額', amountShort: unknownText, amountLong: `${unknownText}，請看說明` };
  if (!g.amountMax) return { amountTitle: '最高金額', amountShort: '金額未公布', amountLong: '金額未公布' };
  return {
    amountTitle: g.fundingType === '競賽獎金' ? '最高獎金' : '最高金額',
    amountShort: amt,
    amountLong: `${amt}${g.approx ? '（外幣換算）' : ''}`,
  };
}

// 回傳給前端時，加上會隨時間或使用者變動的欄位
function toPublicGrant(g, user) {
  const left = daysLeft(g.deadline);
  const { order, ...rest } = g;
  return {
    ...rest,
    ...amountInfo(g),
    cashLabel: CASH_LABELS[g.cash],
    daysLeft: left,
    status: left === null ? 'unknown' : left >= 0 ? 'open' : 'closed',
    isFavorite: Boolean(user && user.favorites.includes(g.id)),
    tracker: user ? user.tracker[g.id] || null : null,
  };
}

const normalizeText = (t) => String(t || '').toLowerCase().replace(/台/g, '臺');

// 同義詞：搜尋其中一個字，其他字也算符合
const SYNONYMS = [
  ['比賽', '競賽', '大賽', '挑戰賽', 'hackathon', '黑客松'],
  ['獎學金', '助學金', '獎助'],
  ['補助', '補貼', '經費'],
  ['創業', '新創', 'startup'],
  ['弱勢', '清寒', '低收', '經濟弱勢', '急難'],
  ['ai', '人工智慧', '機器學習'],
  ['永續', 'esg', '淨零', '減碳', '碳'],
  ['海外', '國際', '出國', '留學', '全球'],
  ['影片', '影音', '微電影', '動畫', '影像'],
  ['寫作', '文學', '小說', '散文', '劇本'],
  ['設計', 'design'],
  ['雲端', '算力', 'gpu'],
].map((group) => group.map(normalizeText));

// 這些詞代表「不要現金獎金」，當成篩選條件而不是文字比對
const NONCASH_WORDS = ['非獎金', '無獎金', '沒有獎金', '沒獎金', '不是獎金', '不要獎金', '不用獎金', '非現金', '不是現金'].map(normalizeText);

function parseKeyword(keyword) {
  let text = normalizeText(keyword);
  let noncash = false;
  for (const w of NONCASH_WORDS) {
    if (text.includes(w)) {
      noncash = true;
      text = text.split(w).join(' ');
    }
  }
  let terms = text.split(/[\s,，、。的]+/).filter(Boolean);
  let honorOnly = false;
  if (noncash) {
    // 「非獎金比賽」：比賽這個詞改成「只看榮譽獎項」，不再拿去比對文字
    const contestWords = SYNONYMS[0];
    terms = terms.filter((t) => {
      if (contestWords.some((w) => t === w)) {
        honorOnly = true;
        return false;
      }
      return true;
    });
  }
  return { terms, noncash, honorOnly };
}

function matchTerm(haystack, term) {
  if (haystack.includes(term)) return true;
  // 沒有直接出現時，找出這個詞裡認得的同義詞組，每一組都要對上
  const groups = SYNONYMS.filter((group) => group.some((w) => term.includes(w)));
  if (groups.length === 0) return false;
  return groups.every((group) => group.some((w) => haystack.includes(w)));
}

function grantHaystack(g) {
  return normalizeText([
    g.name, g.organization, g.description, g.category, g.fundingType, g.payoutTiming, // 不放分類名稱，因為「台灣補助與競賽」會讓搜尋比賽時連補助都跑出來
    ...g.fields, ...g.applicants, ...g.identities, ...g.regions, ...g.stages, ...g.expenses,
    g.fundingTypeDetail, ...g.applicantsDetail, ...g.identitiesDetail, ...g.regionsDetail, ...g.expensesDetail, ...g.schools, g.deadlineNote,
  ].join(' '));
}

// 「不限」代表沒有限制，所以選任何條件都算符合
const includesOrAny = (list, value) => list.includes(value) || list.includes('不限');

function searchGrants(q, user) {
  const { list } = getGrants();
  const { terms, noncash, honorOnly } = parseKeyword(q.keyword);
  const cash = ['grant', 'noncash', 'equity'].includes(q.cash) ? q.cash : noncash ? 'noncash' : '';
  const minAmount = Number(q.minAmount) || 0;
  const flag = (v) => v === '1' || v === 'true';

  const result = list.filter((g) => {
    if (terms.length) {
      const haystack = grantHaystack(g);
      if (!terms.every((t) => matchTerm(haystack, t))) return false;
    }
    if (cash && g.cash !== cash) return false;
    if (honorOnly && g.fundingType !== '榮譽獎項') return false;
    if (q.fundingType && g.fundingType !== q.fundingType) return false;
    if (q.group && g.group !== q.group) return false;
    if (q.applicant && !g.applicants.includes(q.applicant)) return false;
    if (q.identity && !g.identities.includes(q.identity)) return false; // 資格條件：只找「明確限定」這個身分的
    if (q.region && !includesOrAny(g.regions, q.region)) return false;
    if (q.stage && !includesOrAny(g.stages, q.stage)) return false;
    if (q.expense && !includesOrAny(g.expenses, q.expense)) return false;
    if (minAmount && !(g.amountMax >= minAmount)) return false;

    const left = daysLeft(g.deadline);
    if (flag(q.openOnly) && left !== null && left < 0) return false; // 截止日未知的仍保留
    if (flag(q.expiredOnly) && !(left !== null && left < 0)) return false;
    if (flag(q.verifiedOnly) && !g.verifiedAt) return false;
    if (flag(q.favOnly) && !(user && user.favorites.includes(g.id))) return false;
    return true;
  });

  const sort = q.sort || 'recommended';
  const deadlineRank = (g) => {
    const left = daysLeft(g.deadline);
    if (left === null) return 100000; // 未定的排後面
    if (left < 0) return 200000 - left; // 已截止的排最後
    return left;
  };
  // 有關鍵字時，名稱或類型就含有關鍵字的排前面
  const relevance = new Map();
  if (terms.length) {
    for (const g of result) {
      const title = normalizeText(g.name);
      const kind = normalizeText(g.fundingType + ' ' + g.category);
      relevance.set(g.id, terms.reduce((sum, t) => sum + (title.includes(t) ? 3 : 0) + (kind.includes(t) ? 2 : 0), 0));
    }
  }
  const rel = (g) => relevance.get(g.id) || 0;

  result.sort((a, b) => {
    if (sort === 'amountDesc') return (b.amountMax || 0) - (a.amountMax || 0) || a.order - b.order;
    if (sort === 'deadlineAsc') return deadlineRank(a) - deadlineRank(b) || a.order - b.order;
    // 推薦排序：有查證紀錄的優先，其次是有明確截止日且還沒過的
    const va = a.verifiedAt ? 0 : 1;
    const vb = b.verifiedAt ? 0 : 1;
    return rel(b) - rel(a) || va - vb || Math.min(deadlineRank(a), 100000) - Math.min(deadlineRank(b), 100000) || a.order - b.order;
  });
  return result;
}

function countValues(list, key, { skipAny = false } = {}) {
  const counts = new Map();
  for (const g of list) {
    const values = Array.isArray(g[key]) ? g[key] : [g[key]];
    for (const v of values) {
      if (!v || (skipAny && v === '不限')) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

function grantsMeta() {
  const { list } = getGrants();
  const groups = countValues(list, 'group').map(({ value, count }) => ({
    value,
    count,
    label: (GROUPS[value] || OTHER_GROUP).label,
    icon: (GROUPS[value] || OTHER_GROUP).icon,
  }));
  return {
    totalInDb: list.length,
    verifiedInDb: list.filter((g) => g.verifiedAt).length,
    today: todayTaipei(),
    fundingTypes: countValues(list, 'fundingType'),
    cashTypes: ['grant', 'noncash', 'equity'].map((value) => ({ value, label: CASH_LABELS[value], count: list.filter((g) => g.cash === value).length })),
    groups,
    applicants: countValues(list, 'applicants'),
    identities: countValues(list, 'identities', { skipAny: true }),
    regions: countValues(list, 'regions', { skipAny: true }),
    stages: countValues(list, 'stages', { skipAny: true }),
    expenses: countValues(list, 'expenses', { skipAny: true }),
    trackerStatuses: TRACKER_STATUSES,
  };
}

// ======================================================================
// 3. 智慧篩選：把一句話轉成篩選條件（規則式，之後可換成真正的 AI 模型）
// ======================================================================

function smartParse(prompt) {
  const p = String(prompt || '').slice(0, 300);
  const lower = p.toLowerCase();
  const has = (...words) => words.some((w) => p.includes(w) || lower.includes(w.toLowerCase()));
  const f = { keyword: '', cash: '', fundingType: '', applicant: '', identity: '', region: '', stage: '', expense: '', minAmount: 0, openOnly: false };

  const isContest = has('比賽', '競賽', '黑客松', '徵件', '挑戰賽', '選拔', '評選', '獎項');
  if (has('非獎金', '無獎金', '沒有獎金', '沒獎金', '不是獎金', '不要獎金', '不用獎金', '非現金', '不是現金', '榮譽', '免費資源', '雲端額度', '輔導資源')) {
    f.cash = 'noncash';
    if (isContest) f.fundingType = '榮譽獎項'; // 沒有獎金的比賽 → 榮譽獎項
  } else if (has('股權', '創投', '投資', '加速器')) {
    f.cash = 'equity';
  } else {
    if (has('不用還', '無償', '免還')) f.cash = 'grant';
    if (has('獎學金', '助學金')) f.fundingType = '獎學金';
    else if (isContest) f.fundingType = '競賽獎金';
    else if (has('政府補助', '補助')) f.fundingType = '政府補助';
  }

  if (has('公司', '企業', '工廠', '中小企業')) f.applicant = '企業';
  else if (has('非營利', '協會', 'npo', 'ngo', '社團法人')) f.applicant = '非營利組織';
  else if (has('教授', '研究人員', '研究員')) f.applicant = '研究人員';
  else if (has('團隊', '組隊')) f.applicant = has('學生', '大學', '大專', '同學') ? '學生團隊' : '青年團隊';
  else if (has('我是', '學生', '大學生', '高中', '研究生', '碩士', '博士', '個人')) f.applicant = '個人';

  if (has('清寒', '低收', '弱勢', '單親', '隔代', '家境', '經濟困難', '經濟狀況不好')) f.identity = '清寒/經濟弱勢';
  else if (has('原住民')) f.identity = '原住民';
  else if (has('女性創辦', '女生創辦', '女創辦人')) f.identity = '女性創辦人';

  const regionRules = [
    ['新北', ['新北']],
    ['臺北', ['臺北', '台北']],
    ['臺南', ['臺南', '台南']],
    ['高雄', ['高雄']],
    ['新竹', ['新竹']],
    ['桃園', ['桃園']],
    ['歐盟', ['歐盟', '歐洲']],
    ['海外', ['海外', '出國', '國外', '交換學生']],
  ];
  for (const [region, words] of regionRules) {
    if (has(...words)) {
      f.region = region;
      break;
    }
  }

  if (has('構想', '點子', '想法', '還沒開始')) f.stage = '構想中';
  else if (has('籌備', '準備成立', '剛成立')) f.stage = '籌備中';
  else if (has('已經在做', '營運中', '執行中', '已成立')) f.stage = '執行中';

  const expenseRules = [
    ['學費', ['學費']],
    ['生活費', ['生活費']],
    ['研發', ['研發']],
    ['租金', ['房租', '租金']],
    ['人事', ['薪資', '人事']],
    ['器材', ['設備', '器材']],
  ];
  for (const [expense, words] of expenseRules) {
    if (has(...words)) {
      f.expense = expense;
      break;
    }
  }

  const topicRules = [
    ['雲端', () => has('雲端', '算力', 'gpu')],
    ['AI', () => /(^|[^a-z])ai([^a-z]|$)/i.test(p) || has('人工智慧')],
    ['淨零', () => has('淨零', '減碳')],
    ['永續', () => has('永續', 'esg')],
    ['設計', () => has('設計')],
    ['攝影', () => has('攝影')],
    ['文學', () => has('文學', '寫作', '小說', '散文')],
    ['影', () => has('微電影', '影片', '短影音', '動畫')],
    ['黑客松', () => has('黑客松', 'hackathon')],
    ['行銷', () => has('行銷')],
    ['地方創生', () => has('地方創生', '返鄉')],
    ['創業', () => has('創業')],
    ['研究', () => has('研究', '專題')],
    ['醫療', () => has('醫療', '醫學')],
  ];
  for (const [keyword, test] of topicRules) {
    if (test()) {
      f.keyword = keyword;
      break;
    }
  }

  const wan = p.match(/(\d+(?:\.\d+)?)\s*萬/);
  if (wan) f.minAmount = Math.round(parseFloat(wan[1]) * 10000);

  if (has('還沒截止', '尚未截止', '未截止', '現在能申請', '可以申請的')) f.openOnly = true;

  const parts = [
    f.cash && `資金性質「${CASH_LABELS[f.cash]}」`,
    f.fundingType && `類型「${f.fundingType}」`,
    f.applicant && `申請者「${f.applicant}」`,
    f.identity && `資格「${f.identity}」`,
    f.region && `地區「${f.region}」`,
    f.stage && `階段「${f.stage}」`,
    f.expense && `用途「${f.expense}」`,
    f.keyword && `關鍵字「${f.keyword}」`,
    f.minAmount && `金額 NT$ ${f.minAmount.toLocaleString('en-US')} 以上`,
    f.openOnly && '排除已截止',
  ].filter(Boolean);

  const reason = parts.length
    ? `從你的描述找出：${parts.join('、')}。`
    : '沒有從這句話找出明確條件，已顯示全部資料。可以試著寫出身分（學生、團隊、公司）、需求（獎學金、補助、比賽）或領域。';
  return { filters: f, reason };
}

// ======================================================================
// 4. 帳號與登入
// ======================================================================

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSeconds) {
  return [
    `sid=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    IS_PRODUCTION ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function getUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const session = db.sessions[sha256(token)];
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}

function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  for (const [key, s] of Object.entries(db.sessions)) {
    if (s.expiresAt < now) delete db.sessions[key]; // 順手清掉過期的登入
  }
  db.sessions[sha256(token)] = { userId: user.id, expiresAt: now + SESSION_DAYS * 86400000 };
  save('sessions');
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
}

function endSession(req, res) {
  const token = parseCookies(req).sid;
  if (token && db.sessions[sha256(token)]) {
    delete db.sessions[sha256(token)];
    save('sessions');
  }
  res.setHeader('Set-Cookie', sessionCookie('', 0));
}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

const DEFAULT_PROFILE = { applicant: '', region: '', isTaiwanese: true, isLowIncome: false, isFemaleFounder: false };

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt,
    profile: { ...DEFAULT_PROFILE, ...u.profile },
    favorites: u.favorites,
    tracker: u.tracker,
  };
}

// 登入失敗太多次就暫時擋住（每個 IP 15 分鐘內最多 10 次）
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function isLoginBlocked(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const rec = loginFailures.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) loginFailures.set(ip, { count: 1, first: Date.now() });
  else rec.count += 1;
}

// ======================================================================
// 5. 小工具
// ======================================================================

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100000) {
        reject(new HttpError(413, '資料太大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'JSON 格式錯誤'));
      }
    });
    req.on('error', reject);
  });
}

const isEmail = (s) => typeof s === 'string' && s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function requireUser(req) {
  const user = getUser(req);
  if (!user) throw new HttpError(401, '請先登入');
  return user;
}

function requireGrant(id) {
  const g = getGrants().byId.get(id);
  if (!g) throw new HttpError(404, '找不到這筆資料');
  return g;
}

// ======================================================================
// 6. API 路由
// ======================================================================

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // 防止其他網站偷偷代替使用者送出請求（CSRF）
  if (method !== 'GET') {
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {}
      if (originHost !== req.headers.host && originHost !== req.headers['x-forwarded-host']) throw new HttpError(403, '不允許的來源');
    }
    if ((method === 'POST' || method === 'PUT') && !(req.headers['content-type'] || '').includes('application/json')) {
      throw new HttpError(415, '請用 JSON 格式送出');
    }
  }

  const user = getUser(req);

  // ---------- 獎助資料 ----------
  if (method === 'GET' && pathname === '/api/grants/meta') {
    return sendJson(res, 200, grantsMeta());
  }

  if (method === 'GET' && pathname === '/api/grants') {
    const q = Object.fromEntries(url.searchParams);
    const all = searchGrants(q, user);
    const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 24, 1), 100);
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const page = Math.min(Math.max(parseInt(q.page, 10) || 1, 1), totalPages);
    return sendJson(res, 200, {
      items: all.slice((page - 1) * pageSize, page * pageSize).map((g) => toPublicGrant(g, user)),
      total: all.length,
      verifiedCount: all.filter((g) => g.verifiedAt).length,
      totalInDb: getGrants().list.length,
      page,
      pageSize,
      totalPages,
    });
  }

  const grantMatch = pathname.match(/^\/api\/grants\/([A-Za-z0-9_-]+)$/);
  if (method === 'GET' && grantMatch) {
    return sendJson(res, 200, toPublicGrant(requireGrant(grantMatch[1]), user));
  }

  if (method === 'POST' && pathname === '/api/smart-search') {
    const body = await readBody(req);
    const prompt = str(body.prompt, 300);
    if (!prompt) throw new HttpError(400, '請輸入一句話描述你的需求');
    return sendJson(res, 200, smartParse(prompt));
  }

  // ---------- 註冊 / 登入 / 登出 ----------
  if (method === 'POST' && pathname === '/api/auth/register') {
    const body = await readBody(req);
    const name = str(body.name, 30);
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    if (!name) throw new HttpError(400, '請填寫暱稱');
    if (!isEmail(email)) throw new HttpError(400, '電子郵件格式不正確');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, '密碼至少 8 個字元');
    if (db.users.some((u) => u.email === email)) throw new HttpError(409, '這個信箱已經註冊過，請直接登入');

    const { salt, hash } = await hashPassword(password);
    const newUser = {
      id: crypto.randomUUID(),
      name,
      email,
      salt,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      profile: { ...DEFAULT_PROFILE },
      favorites: [],
      tracker: {},
    };
    db.users.push(newUser);
    save('users');
    startSession(res, newUser);
    return sendJson(res, 201, { user: publicUser(newUser) });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    // 透過雲端或分享通道連進來時，用真實使用者的 IP 計算登入失敗次數
    const forwarded = (IS_PRODUCTION || SHARE) && (String(req.headers['cf-connecting-ip'] || '') || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim());
    const ip = forwarded || req.socket.remoteAddress || 'unknown';
    if (isLoginBlocked(ip)) throw new HttpError(429, '嘗試次數太多，請 15 分鐘後再試');
    const body = await readBody(req);
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    const found = db.users.find((u) => u.email === email);

    // 帳號不存在時也算一次雜湊，讓回應時間差不多，避免被用來猜哪些信箱有註冊
    const { hash } = await hashPassword(password, found && found.salt ? found.salt : '00'.repeat(16));
    const ok = Boolean(found && found.passwordHash) && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(found.passwordHash, 'hex'));
    if (!ok) {
      recordLoginFailure(ip);
      throw new HttpError(401, '信箱或密碼錯誤');
    }
    loginFailures.delete(ip);
    startSession(res, found);
    return sendJson(res, 200, { user: publicUser(found) });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    endSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    return sendJson(res, 200, { user: user ? publicUser(user) : null });
  }

  // ---------- 我的資料（需登入） ----------
  if (method === 'PUT' && pathname === '/api/me/profile') {
    const me = requireUser(req);
    const body = await readBody(req);
    const meta = grantsMeta();
    const applicant = str(body.applicant, 30);
    const region = str(body.region, 30);
    if (applicant && !meta.applicants.some((a) => a.value === applicant)) throw new HttpError(400, '申請者身分不正確');
    me.profile = {
      applicant,
      region,
      isTaiwanese: Boolean(body.isTaiwanese),
      isLowIncome: Boolean(body.isLowIncome),
      isFemaleFounder: Boolean(body.isFemaleFounder),
    };
    save('users');
    return sendJson(res, 200, { user: publicUser(me) });
  }

  const favMatch = pathname.match(/^\/api\/me\/favorites\/([A-Za-z0-9_-]+)$/);
  if (favMatch && (method === 'POST' || method === 'DELETE')) {
    const me = requireUser(req);
    const id = favMatch[1];
    if (method === 'POST') {
      requireGrant(id);
      if (!me.favorites.includes(id)) me.favorites.push(id);
    } else {
      me.favorites = me.favorites.filter((x) => x !== id);
    }
    save('users');
    return sendJson(res, 200, { favorites: me.favorites });
  }

  if (method === 'GET' && pathname === '/api/me/tracker') {
    const me = requireUser(req);
    const { byId } = getGrants();
    const items = Object.entries(me.tracker)
      .map(([id, t]) => ({ ...t, grant: byId.has(id) ? toPublicGrant(byId.get(id), me) : { id, name: '（此筆資料已移除）' } }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return sendJson(res, 200, { items });
  }

  const trackMatch = pathname.match(/^\/api\/me\/tracker\/([A-Za-z0-9_-]+)$/);
  if (trackMatch && (method === 'PUT' || method === 'DELETE')) {
    const me = requireUser(req);
    const id = trackMatch[1];
    if (method === 'PUT') {
      requireGrant(id);
      const body = await readBody(req);
      const status = str(body.status, 10);
      if (!TRACKER_STATUSES.includes(status)) throw new HttpError(400, '狀態不正確');
      me.tracker[id] = { status, note: str(body.note, 1000), updatedAt: new Date().toISOString() };
    } else {
      delete me.tracker[id];
    }
    save('users');
    return sendJson(res, 200, { tracker: me.tracker });
  }

  // ---------- 電子報、主辦諮詢 ----------
  if (method === 'POST' && pathname === '/api/subscriptions') {
    const body = await readBody(req);
    const email = str(body.email, 200).toLowerCase();
    if (!isEmail(email)) throw new HttpError(400, '電子郵件格式不正確');
    if (!db.subscribers.some((s) => s.email === email)) {
      db.subscribers.push({ email, createdAt: new Date().toISOString() });
      save('subscribers');
    }
    return sendJson(res, 201, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/host-inquiries') {
    const body = await readBody(req);
    const org = str(body.org, 100);
    const email = str(body.email, 200).toLowerCase();
    const service = str(body.service, 50);
    const message = str(body.message, 2000);
    if (!org) throw new HttpError(400, '請填寫單位名稱');
    if (!isEmail(email)) throw new HttpError(400, '電子郵件格式不正確');
    db.inquiries.push({ id: crypto.randomUUID(), org, email, service, message, createdAt: new Date().toISOString() });
    save('inquiries');
    return sendJson(res, 201, { ok: true });
  }

  throw new HttpError(404, '沒有這個 API');
}

// ======================================================================
// 7. 靜態檔案（前端頁面）
// ======================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let relative;
  try {
    // 首頁是介紹頁，查詢平台在 /app
    const ROUTES = { '/': 'intro.html', '/app': 'index.html', '/app/': 'index.html' };
    relative = ROUTES[pathname] || decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('找不到頁面');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    res.end(data);
  });
}

// ======================================================================
// 8. 啟動伺服器
// ======================================================================

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: '伺服器發生錯誤' });
  }
});

function openBrowser(link) {
  // 雲端主機（Render 等）不需要開瀏覽器
  if (process.env.NO_OPEN || process.env.RENDER || IS_PRODUCTION) return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]]
    : process.platform === 'darwin' ? ['open', [link]]
    : ['xdg-open', [link]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n埠號 ${PORT} 已經被占用：可能網站已經開著了。`);
    console.error(`請直接用瀏覽器打開 http://127.0.0.1:${PORT}，或關掉另一個黑色視窗後再試一次。\n`);
  } else {
    console.error('伺服器啟動失敗：', err.message);
  }
  process.exit(1);
});

try {
  getGrants();
} catch (err) {
  console.error('\n讀不到 data/grants.json：', err.message);
  console.error('請確認 data 資料夾裡有 grants.json，而且是正確的 JSON 格式。\n');
  process.exit(1);
}

// ----- 分享網址（Cloudflare Quick Tunnel）-----
function findCloudflared() {
  const local = path.join(__dirname, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  try {
    const r = require('child_process').spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return 'cloudflared';
  } catch {}
  return null;
}

function copyToClipboard(text) {
  const cmd = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : null;
  if (!cmd) return false;
  try {
    const p = spawn(cmd, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.end(text);
    return true;
  } catch {
    return false;
  }
}

function startShareTunnel() {
  const exe = findCloudflared();
  if (!exe) {
    console.log('找不到 cloudflared，無法產生分享網址（網站本身仍可在這台電腦使用）。');
    console.log('Windows：請用「share-windows.bat」啟動，它會幫你下載。Mac：請先執行 brew install cloudflared。\n');
    return;
  }
  console.log('正在產生分享網址，大約需要 5 到 20 秒…\n');
  const tunnel = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let shown = false;
  let log = '';
  const onData = (chunk) => {
    log = (log + chunk).slice(-4000);
    const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true;
      const copied = copyToClipboard(m[0]);
      console.log('\n************************************************************');
      console.log(' 分享網址（把這個傳給別人）：');
      console.log(`   ${m[0]}`);
      if (copied) console.log(' 已經複製到剪貼簿，直接貼上就可以。');
      console.log(' 剛產生的網址可能要等半分鐘才打得開。');
      console.log(' 這個視窗關掉或電腦睡眠，網址就會失效；每次重開網址都不一樣。');
      console.log('************************************************************\n');
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('error', (err) => console.error('分享通道啟動失敗：', err.message));
  tunnel.on('exit', () => {
    if (!shown) {
      console.error('\n分享通道沒有成功建立。請確認電腦有連上網路，再重新啟動一次。');
      console.error('cloudflared 的訊息：\n' + log.split('\n').slice(-6).join('\n'));
    } else {
      console.log('分享通道已關閉，分享網址失效。');
    }
  });
  const stop = () => {
    tunnel.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => tunnel.kill());
}

server.listen(PORT, HOST, () => {
  const link = `http://127.0.0.1:${PORT}`;
  console.log('\n========================================');
  console.log(' 益起出發 已啟動！');
  console.log(` 你自己用：${link}`);
  console.log(' 這個視窗請保持開著，關掉網站就會停止。');
  console.log('========================================\n');
  openBrowser(link);
  if (SHARE) startShareTunnel();
});

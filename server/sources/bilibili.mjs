import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { subtitleWarnings } from './warnings.mjs';
import { fileURLToPath } from 'node:url';
import { log } from '../core/log.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const COOKIE_CANDIDATES = [
  process.env.BILI_COOKIE_FILE,
  path.join(ROOT, '.secrets', 'bili.cookie'),
  path.join(ROOT, '..', '.secrets', 'bili.cookie'),
].filter(Boolean);

/** 凭据只从本地文件读；永不打印、永不进 prompt。 */
export function cookieFile() {
  const found = COOKIE_CANDIDATES.find((f) => fs.existsSync(f));
  if (!found) throw new Error('bilibili cookie file not found (expected .secrets/bili.cookie)');
  return found;
}

export function loadCookie() {
  const raw = fs.readFileSync(cookieFile(), 'utf8').replace(/^\uFEFF/, '');
  const cookie = raw
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ')
    .replace(/;+$/, '');
  if (!/SESSDATA=/.test(cookie)) throw new Error('cookie file has no SESSDATA');
  return cookie;
}

function request(url, cookie, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 20000,
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    // 注意：错误信息里只出现 host+path，不出现 cookie
    req.on('error', (e) => {
      if (depth < 3) {
        setTimeout(() => request(url, cookie, depth + 1).then(resolve, reject), 1200);
        return;
      }
      reject(new Error(`${new URL(url).host}${new URL(url).pathname}: ${e.message}`));
    });
  });
}

const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

async function wbiMixin(cookie) {
  const nav = json(await request('https://api.bilibili.com/x/web-interface/nav', cookie));
  const imgKey = (nav?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
  const subKey = (nav?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
  return { mixin: MIXIN.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32), isLogin: nav?.data?.isLogin };
}

function signed(params, mixin) {
  params.wts = Math.floor(Date.now() / 1000);
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

export async function fetchVideo(bvid) {
  const cookie = loadCookie();
  const view = json(await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, cookie));
  if (view.code !== 0) throw new Error(`view failed: ${view.code} ${view.message}`);
  return {
    bvid,
    title: view.data.title,
    pages: (view.data.pages || []).map((p) => ({ page: p.page, cid: p.cid, part: p.part, duration: p.duration })),
  };
}

/** @returns {{ok:boolean, cues?:Array<{from:number,to:number,text:string}>, quality:object, langs?:string[]}} */
export async function fetchSubtitle(bvid, page = 1) {
  const cookie = loadCookie();
  const { mixin, isLogin } = await wbiMixin(cookie);
  const video = await fetchVideo(bvid);
  const target = video.pages.find((p) => p.page === Number(page)) || video.pages[0];
  if (!target) throw new Error('video has no pages');

  const player = json(
    await request(
      `https://api.bilibili.com/x/player/wbi/v2?${signed({ bvid, cid: target.cid }, mixin)}`,
      cookie,
    ),
  );
  const subtitles = player?.data?.subtitle?.subtitles || [];
  if (!subtitles.length) {
    const quality = assessSubtitles([]);
    log(`subtitle miss bvid=${bvid} p=${target.page} isLogin=${isLogin}`);
    return { ok: false, quality, langs: [] };
  }

  const track = subtitles.find((s) => s.lan === 'zh-Hans') || subtitles.find((s) => /zh/i.test(s.lan)) || subtitles[0];
  const url = track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
  const body = json(await request(url, cookie));
  const cues = (body.body || []).map((l) => ({ from: l.from, to: l.to, text: l.content }));

  // 字幕质量闸（签字第 5 条）
  const quality = assessSubtitles(cues);
  const ok = quality.verdict === 'ok';
  log(`subtitle fetched bvid=${bvid} p=${target.page} track=${track.lan} lines=${cues.length} verdict=${quality.verdict}`);
  return { ok, cues, quality, langs: subtitles.map((s) => s.lan) };
}

const TERMS = ['向量', '矩阵', '线性变换', '行列式', '特征值', '基', '张成', '点积', '叉积', '空间'];

/**
 * 字幕质量闸 —— 只做**统计层**的体检，必须按"段"调用，不能拿整门课的平均值糊过去。
 *
 * 能挡住的：没有字幕、太稀疏、同一句反复出现（ASR 卡住/无语音）、乱码率过高、碎成单字。
 * **挡不住的：语义错误。** 例如把"磷离子"识别成"哦那鹏还是邻啊啊"，长度、时长、字符集都正常，
 * 统计量看不出来。这类错误的唯一兜底是"允许弃权 + 人工抽检"，不要指望这个函数。
 *
 * termHits 只作为**信号**回报给调用方（供出题时决定是否弃权），不参与 verdict。
 */
export function assessSubtitles(cues) {
  const lines = cues.map((c) => String(c.text || '').trim()).filter(Boolean);
  const text = lines.join('');
  const chars = text.length;
  // 时长必须是"本段跨度"，不是最后一条的绝对时间戳：按段质检时后半段
  // 会被算成整集时长，语速被低估成 too-sparse（P3 实测踩到过）。
  const duration = cues.length ? Number(cues[cues.length - 1].to) - Number(cues[0].from) : 0;
  const charsPerMin = duration > 0 ? (chars / duration) * 60 : 0;
  const avgLineChars = lines.length ? chars / lines.length : 0;

  const suspicious = lines.filter(
    (l) => /(.)\1{2,}/.test(l) || l.length < 2 || !/[\u4e00-\u9fa5A-Za-z0-9]/.test(l),
  ).length;
  const garbleRate = lines.length ? suspicious / lines.length : 1;

  // 同一句反复出现 = 音频没有有效语音（ASR 卡住、纯音乐、静音被幻觉成固定句子）
  const uniqueLines = new Set(lines).size;
  const dupRate = lines.length ? 1 - uniqueLines / lines.length : 1;

  const termHits = TERMS.filter((t) => text.includes(t)).length;

  let verdict = 'ok';
  if (!lines.length) verdict = 'no-subtitles';
  else if (charsPerMin < 60) verdict = 'too-sparse';
  else if (dupRate > 0.3) verdict = 'degenerate';
  else if (garbleRate > 0.35) verdict = 'too-garbled';
  else if (avgLineChars < 2) verdict = 'fragmented';

  return {
    lines: lines.length,
    chars,
    duration: Number(duration.toFixed(0)),
    charsPerMin: Number(charsPerMin.toFixed(0)),
    avgLineChars: Number(avgLineChars.toFixed(1)),
    garbleRate: Number(garbleRate.toFixed(3)),
    dupRate: Number(dupRate.toFixed(3)),
    termHits,
    verdict,
    scope: 'statistical-only',
    warnings: cues.flatMap((cue) => subtitleWarnings(String(cue.text || ''), {
      coordinate: 'subtitle-cue-text', from: cue.from ?? null, to: cue.to ?? null,
    })),
  };
}

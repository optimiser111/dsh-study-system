import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { videoIdentity } from './collector.mjs';
import { readPlayerBridge } from './desktop-player.mjs';
import { fetchVideo } from '../sources/bilibili.mjs';
import { suggestSubject } from '../core/subjects.mjs';
const execute = promisify(execFile);
async function restartDesktop(clientPath) {
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('../../Start-BilibiliLearning.ps1', import.meta.url)),
    '-ClientPath', clientPath, '-PlayerBridge', '-Restart'], { windowsHide: true, timeout: 30000, maxBuffer: 65536 });
}
export async function probeDesktop() {
  if (process.platform !== 'win32') return { detected: false, errorCode: 'windows-required' };
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./desktop-probe.ps1',import.meta.url))], { windowsHide: true, timeout: 8000, maxBuffer: 512*1024, encoding: 'utf8' });
    const snapshot = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (snapshot.bridgePort && !snapshot.locked) snapshot.player = await readPlayerBridge(snapshot.bridgePort);
    return snapshot;
  } catch { return { detected: false, errorCode: 'probe-unavailable' }; }
}
export function clockSeconds(text) {
  if (typeof text !== 'string' || !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) return null;
  const pieces = text.split(':').map(Number);
  if (pieces.slice(1).some((n) => n >= 60)) return null;
  return pieces.reduce((total,n) => total*60+n,0);
}
const genericTitle = /^(?:哔哩哔哩|bilibili|bilibili客户端|哔哩哔哩客户端|bilibili播放器)$/i;
export function interpretDesktop(raw, binding = null) {
  const result = { detected: !!raw?.detected, state: raw?.errorCode || 'unavailable', candidate: null, capabilities: { identity: false, position: false, playback: false, rate: false }, observation: null };
  if (!raw?.detected) return result;
  const app = raw.app || {}, media = raw.media || {}, nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const titleNode = nodes.find((n) => /video[-_]?title|视频标题/i.test(n.id || '') && n.name);
  const title = String(media.title || titleNode?.name || app.windowTitle || '').trim().slice(0,300);
  const currentTexts = [media.title,media.subtitle,app.windowTitle,...nodes.filter((n) => ['Document','Edit'].includes(n.type)).flatMap((n) => [n.name,n.value])].filter((s) => typeof s === 'string');
  const identities = currentTexts.flatMap((text) => (text.match(/https:\/\/(?:www\.)?bilibili\.com\/video\/BV[a-zA-Z0-9]{10}\/?(?:\?[^\s"<>]*)?/g) || []).map((url) => {
    const parsed = videoIdentity(url); return parsed && /[?&]p=\d+(?:&|$)/.test(url) ? parsed : null;
  }).filter(Boolean));
  const unique = [...new Map(identities.map((i) => [i.bvid+':'+i.page,i])).values()];
  let identity = unique.length === 1 ? unique[0] : null;
  let position = Number.isFinite(media.position) && media.position >= 0 ? media.position : null;
  let duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null;
  let playing = media.status === 'Playing' ? true : ['Paused','Stopped','Closed'].includes(media.status) ? false : null;
  let rate = Number.isFinite(media.rate) && media.rate >= .25 && media.rate <= 4 ? media.rate : null;
  const player = raw.player;
  if (player?.hasVideo && Number.isFinite(player.position) && player.position >= 0 && Number.isFinite(player.duration) && player.duration > 0 && player.position <= player.duration) {
    position = player.position; duration = player.duration;
    rate = Number.isFinite(player.rate) && player.rate >= .25 && player.rate <= 4 ? player.rate : null;
    playing = typeof player.playing === 'boolean' ? player.playing : null;
    if (videoIdentity(player.bvid)?.bvid === player.bvid && Number.isInteger(Number(player.page)) && Number(player.page) >= 1 && Number(player.page) <= 10000) identity = { bvid: player.bvid,page: Number(player.page) };
  }
  // Prefer real, visible player times. Never extrapolate a stale media timeline with wall time.
  const timePairs = nodes.map((n) => String(n.name || '').match(/^(\d{1,3}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,3}:\d{2}(?::\d{2})?)$/)).filter(Boolean);
  const clocks = timePairs.map((m) => ({ position: clockSeconds(m[1]), duration: clockSeconds(m[2]) })).filter((t) => t.position !== null && t.duration > 0 && t.position <= t.duration);
  if (clocks.length === 1) { position = clocks[0].position; duration = clocks[0].duration; }
  const buttons = nodes.filter((n) => n.type === 'Button').map((n) => n.name || '');
  const pause = buttons.some((name) => /^(?:暂停|暂停播放|Pause)$/i.test(name));
  const play = buttons.some((name) => /^(?:播放|继续播放|Play)$/i.test(name));
  if (pause !== play) playing = pause;
  const rates = [...new Set(nodes.map((n) => String(n.name || '').match(/^([0-4](?:\.\d+)?)\s*(?:x|倍速|倍)$/i)?.[1]).filter(Boolean).map(Number).filter((n) => n >= .25 && n <= 4))];
  if (rates.length === 1) rate = rates[0];
  if (position !== null && duration !== null && position > duration) position = null;
  const specific = title && !genericTitle.test(title.replace(/[\s·\-_]/g,''));
  const signature = specific && duration ? createHash('sha256').update(JSON.stringify([app.executable || app.name,app.processId,title,duration,player?.bvid || null,player?.cid || null])).digest('hex') : null;
  if (signature) result.candidate = { signature, title, duration, suggestedSubject: suggestSubject(title) };
  const ambiguous = unique.length > 1;
  if (!identity && !ambiguous && binding?.signature === signature && videoIdentity(binding.bvid)?.bvid === binding.bvid && Number.isInteger(binding.page) && binding.page >= 1 && binding.page <= 10000) identity = { bvid: binding.bvid, page: binding.page };
  result.capabilities = { identity: !!identity, position: position !== null && !!duration, playback: playing !== null, rate: rate !== null };
  if (ambiguous) identity = null;
  result.capabilities.identity = !!identity;
  const samePlayerWindow = !!app.foreground && !!player?.playing && !!player.title?.trim() &&
    String(app.windowTitle || '').trim() === player.title.trim();
  result.state = raw.locked ? 'locked' : ambiguous ? 'ambiguous' : !identity ? 'needs-identity' : position === null || !duration ? 'needs-position' : playing === null ? 'needs-playback' : playing && rate === null ? 'needs-rate' : !app.foreground ? 'background' : playing ? 'ready' : 'paused';
  result.observation = {
    source: 'desktop', title, url: identity ? 'https://www.bilibili.com/video/'+identity.bvid+'/?p='+identity.page : '',
    processId: app.processId,
    position, rate: rate ?? 1, playing: !!playing && rate !== null && position !== null && !!duration && !!identity,
    visible: !!app.foreground && (!player || player.visible !== false || samePlayerWindow), focused: !!app.foreground, idleState: raw.locked ? 'locked' : 'active',
  };
  return result;
}
export class DesktopCapture {
  constructor(collector, { probe = probeDesktop, getVideo = fetchVideo, launch = restartDesktop } = {}) { this.collector = collector; this.probe = probe; this.getVideo = getVideo; this.launch = launch; this.catalog = new Map(); this.state = { state: 'disabled', capabilities: {}, candidate: null }; this.pending = false; this.closed = false; this.preparationFailed = false; this.awaitingBridge = false; this.bridgeDeadline = 0; }
  view() { return this.state; }
  resetPreparation() { this.preparationFailed = false; this.awaitingBridge = false; }
  async poll() {
    if (this.closed || this.pending) return;
    if (!this.collector.settings.desktopEnabled) { this.state = { state: 'disabled', capabilities: {}, candidate: null }; return; }
    this.pending = true;
    try {
      const snapshot = await this.probe();
      if (this.closed || !this.collector.settings.desktopEnabled) return;
      if (snapshot.bridgePort) this.awaitingBridge = false;
      if (this.collector.settings.autoConfirm && snapshot.detected && !snapshot.bridgePort && snapshot.app?.executable) {
        if (this.awaitingBridge && Date.now() >= this.bridgeDeadline) { this.preparationFailed = true; this.awaitingBridge = false; }
        if (this.preparationFailed) { this.state = { state: 'bridge-start-failed', capabilities: {}, candidate: null }; return; }
        this.state = { state: 'bridge-starting', capabilities: {}, candidate: null };
        if (this.awaitingBridge) return;
        this.awaitingBridge = true;
        this.bridgeDeadline = Date.now() + 45000;
        try { await this.launch(snapshot.app.executable); }
        catch { this.preparationFailed = true; this.awaitingBridge = false; this.state = { state: 'bridge-start-failed', capabilities: {}, candidate: null }; }
        return;
      }
      const player = snapshot.player;
      if (videoIdentity(player?.bvid)?.bvid === player?.bvid && player?.cid) {
        let entry = this.catalog.get(player.bvid);
        if (!entry || Date.now()-entry.at > 600000) {
          try { entry = { at:Date.now(),video:await this.getVideo(player.bvid) }; } catch { entry = { at:Date.now(),video:null }; }
          this.catalog.set(player.bvid,entry);
        }
        const page = entry.video?.pages.find((p) => String(p.cid) === String(player.cid));
        const suppliedPage = Number(player.page);
        player.page = page?.page || (!entry.video && Number.isInteger(suppliedPage) && suppliedPage >= 1 && suppliedPage <= 10000 ? suppliedPage : null);
      }
      if (this.closed || !this.collector.settings.desktopEnabled) return;
      const interpreted = interpretDesktop(snapshot,this.collector.settings.desktopBinding);
      const { observation, ...view } = interpreted;
      this.state = { ...view, identity: videoIdentity(observation?.url), checkedAt: Date.now() };
      // No raw accessibility tree, process path, media metadata or screenshot goes into SQLite.
      if (observation) this.collector.observe(observation);
      else if (this.collector.lastSource === 'desktop') this.collector.observe({ source: 'desktop', focused: false });
    } catch { this.state = { state:'probe-unavailable',capabilities:{},candidate:null }; }
    finally { this.pending = false; }
  }
  stop() { this.closed = true; }
}

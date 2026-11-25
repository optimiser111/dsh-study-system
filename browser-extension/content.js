// 只在B站视频页运行。不访问Cookie，不请求本地服务，不读取其他标签页。
(() => {
  let sending = false, lastTarget = null;
  function sample(forceEnded = false) {
    const video = document.querySelector('video');
    const url = new URL(location.href);
    if (!/^\/video\/BV[a-zA-Z0-9]{10}\/?$/.test(url.pathname)) return;
    return {
      url: 'https://www.bilibili.com'+url.pathname+'?p='+(url.searchParams.get('p') || '1'),
      title: document.title.slice(0,300), visible: document.visibilityState === 'visible',
      position: Number.isFinite(video?.currentTime) ? video.currentTime : 0,
      playing: !!video && !video.paused && !video.ended && !video.seeking && video.readyState >= 3,
      rate: video?.playbackRate || 1, ended: forceEnded || !!video?.ended,
    };
  }
  async function report(ended = false) {
    if (sending) return;
    const observation = sample(ended); if (!observation) return;
    sending = true;
    try { await chrome.runtime.sendMessage({ type: 'study-observe', observation }); }
    catch { /* 扩展更新/服务离线时不缓存或补算观看时间。 */ }
    finally { sending = false; }
  }
  setInterval(() => {
    const video = document.querySelector('video');
    if (video && video !== lastTarget) {
      lastTarget = video;
      video.addEventListener('ended', () => report(true));
      video.addEventListener('pause', () => report());
      video.addEventListener('seeking', () => report());
      video.addEventListener('play', () => report());
    }
    report();
  }, 5000);
  document.addEventListener('visibilitychange', () => report());
  report();
})();

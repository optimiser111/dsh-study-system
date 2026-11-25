const fields = ['port','token','enabled'];
chrome.storage.local.get([...fields,'lastStatus','lastContact']).then((values) => {
  document.getElementById('port').value = String(values.port || 7788);
  document.getElementById('token').value = values.token || '';
  document.getElementById('enabled').checked = !!values.enabled;
  document.getElementById('status').textContent = values.lastStatus || '尚未连接';
});
document.getElementById('save').addEventListener('click', async () => {
  const token = document.getElementById('token').value.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) { document.getElementById('status').textContent = '请输入完整的64位本地配对码。'; return; }
  await chrome.storage.local.set({ token, port: Number(document.getElementById('port').value), enabled: document.getElementById('enabled').checked });
  document.getElementById('status').textContent = '已保存。请在学习面板选择采集场景并开始采集。';
});

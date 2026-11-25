// Navigation regions inspired by broad education fields; the concrete course
// subject and its evidence remain independent of these display groups.
export const SUBJECT_AREAS = [
  { id: 'formal', label: '数学与形式科学', tone: '#6de9d2' },
  { id: 'natural', label: '自然与环境科学', tone: '#84cf8c' },
  { id: 'engineering', label: '工程与计算', tone: '#7db8ff' },
  { id: 'health', label: '生命与医学', tone: '#ff9fbd' },
  { id: 'social', label: '社会与行为科学', tone: '#f4cc81' },
  { id: 'humanities', label: '人文与艺术', tone: '#c9a0ff' },
  { id: 'agriculture', label: '农业与资源', tone: '#b3d887' },
  { id: 'unclassified', label: '待确定分区', tone: '#a1afc4' },
];
export const AREA_PROMPT = 'area 为地图导航大类，选用 ' + SUBJECT_AREAS.map(area => area.id + '=' + area.label).join('、') + '。subject 仍是具体学科。优先复用同学科已有分区，依据不足填 unclassified。';
const rules = [
  ['formal', /数学|数理|代数|几何|微积分|逻辑|概率|统计|运筹|^math$|mathematics|statistics|logic/i],
  ['social', /心理|经济|教育|教学|社会|政治|法律|法学|管理|金融|商业|会计|新闻|传播|人类学|psycholog|econom|education|sociolog|law|business/i],
  ['health', /医学|医疗|临床|护理|药学|口腔|康复|解剖|病理|公共卫生|神经科学|medical|medicine|health|neuroscience/i],
  ['agriculture', /农业|农学|林学|园艺|水产|渔业|畜牧|农林|agricultur|forestry/i],
  ['engineering', /计算机|编程|工程|电子|电气|机械|人工智能|数据分析|数据科学|信息技术|软件|建筑|机器人|自然语言处理|地理信息|信号处理|^programming$|engineering|computer|data science|robotics|signal processing/i],
  ['natural', /物理|化学|生物|天文|地理|地质|气象|生态|环境科学|海洋|physics|chemistry|biology|astronomy|geology|ecology/i],
  ['humanities', /播音|主持|语音学|语言|文学|艺术|哲学|历史|考古|音乐|美术|设计|戏剧|影视|^language$|linguistic|phonetic|histor|philosoph|arts|music/i],
];
export function subjectArea(subject, ...declarations) {
  const name = String(subject || '').normalize('NFKC').trim();
  const known = rules.find(([, pattern]) => pattern.test(name))?.[0];
  if (known) return SUBJECT_AREAS.find(area => area.id === known);
  for (const declaration of declarations) {
    const area = SUBJECT_AREAS.find(area => area.id !== 'unclassified' && (area.id === declaration || area.label === declaration));
    if (area) return area;
  }
  return SUBJECT_AREAS.at(-1);
}
export const rootKey = root => 'root:'+root.subject;
export const rootEdge = (root,id) => ({from:rootKey(root),to:id,kind:'root'});
export function directConnections(nodes, edges, selected, roots=[]) {
  const root=roots.find(r=>rootKey(r)===selected);
  if(root){const ids=new Set(root.children.filter(id=>nodes.some(n=>n.id===id)));return {selected,rootSelected:true,nodes:ids,roots:new Set([selected]),edges:new Set([...ids].map(id=>edgeKey(rootEdge(root,id))))};}
  if (!selected || !nodes.some(n => n.id === selected)) return null;
  const ids = new Set([selected]);
  const links = edges.filter(e => e.from === selected || e.to === selected);
  links.forEach(e => { ids.add(e.from); ids.add(e.to); });
  const linkedRoots=roots.filter(r=>r.children.includes(selected));
  return { selected, nodes: ids,roots:new Set(linkedRoots.map(rootKey)), edges: new Set([...links.map(edgeKey),...linkedRoots.map(r=>edgeKey(rootEdge(r,selected)))]) };
}
export const edgeKey = e => `${e.from}:${e.to}:${e.kind || ''}`;

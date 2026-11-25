// 人工整理的数学知识邻域；连线是建议先修关系，不是课程官方顺序或能力证明。
export const CATALOG_VERSION = 'math-neighborhood-v2';
export const SOURCES = [
  { title: 'MIT OCW · 线性代数章节参考', url: 'https://ocw.mit.edu/courses/18-06sc-linear-algebra-fall-2011/pages/syllabus/' },
  { title: 'MIT OCW · 单变量微积分章节参考', url: 'https://ocw.mit.edu/courses/18-01sc-single-variable-calculus-fall-2010/pages/syllabus/' },
  { title: 'MIT OCW · 多变量微积分章节参考', url: 'https://ocw.mit.edu/courses/18-02sc-multivariable-calculus-fall-2010/pages/syllabus/' },
];
// 世界坐标Y越小越高：基础在树根，高级内容沿建议先修关系向上分叉。
const TREE_LAYOUT = {
  arithmetic: [0,390,0], functions: [45,245,-55], vectors: [-45,245,55],
  limits: [110,110,-65], coordinates: [-100,110,65],
  derivatives: [200,-15,-50], addition: [-275,-15,95], scaling: [-100,-15,-110],
  'linear-combinations': [-265,-115,20], integrals: [300,-145,-80], partials: [275,-145,150],
  basis: [-400,-210,100], matrices: [-265,-210,-130],
  'linear-transformations': [-430,-290,80], rank: [-260,-310,-30],
  determinants: [-485,-375,-40], inverse: [-590,-375,160], eigen: [-420,-500,120],
  series: [525,-390,-170], 'double-integrals': [435,-355,120],
};
const node = (id, title, branch, position, prerequisites, description, check) => ({ id, title, branch, position: TREE_LAYOUT[id] || position, prerequisites, description,
  check: { question: check[0], options: check[1], answer: check[2], explanation: check[3] } });
export const CATALOG = [
  node('arithmetic', '数与代数运算', '基础', [0,-440,0], [], '用数和符号表达运算，是后续两条路径的共同基础。', ['2×(3+1) 等于多少？', ['8','7','10','6'], 'A', '先算括号内3+1=4，再乘2得到8。']),
  node('functions', '函数与图像', '微积分', [-310,-290,100], ['arithmetic'], '把输入、输出与图像对应起来，观察变化。', ['函数 f(x)=x²，当 x=3 时输出是什么？', ['3','6','9','12'], 'C', '把输入3代入，3²=9。']),
  node('limits', '极限与连续', '微积分', [-310,-130,50], ['functions'], '关注自变量接近某处时，函数值的趋势。', ['当 x 越来越接近2时，x+1 越来越接近多少？', ['0','1','2','3'], 'D', 'x接近2时，x+1接近3。']),
  node('derivatives', '导数与变化率', '微积分', [-310,30,20], ['limits'], '用局部变化率描述切线斜率与瞬时变化。', ['f(x)=x²，在 x=3 处的导数是多少？', ['3','6','9','12'], 'B', 'f′(x)=2x，代入3得到6。单题通过只说明这一小项有正确作答证据。']),
  node('integrals', '积分与累积', '微积分', [-420,200,-40], ['derivatives'], '把局部贡献累积起来，并联系求导与求原函数。', ['∫₀² x dx 等于多少？', ['1','2','3','4'], 'B', '原函数为x²/2，在0到2之间的变化为2。']),
  node('partials', '偏导数', '多变量', [-100,210,180], ['derivatives','functions'], '固定其他变量，观察一个方向上的变化率。', ['f(x,y)=x²+y，固定y，对x求偏导得到什么？', ['2x','2y','x²','1'], 'A', 'y保持不变，对x求导时它是常数，结果为2x。']),
  node('double-integrals', '二重积分', '多变量', [-170,390,100], ['integrals','partials'], '在二维区域内累积局部量，联系区域与积分次序。', ['在单位正方形[0,1]×[0,1]上，对常数1做二重积分，结果是多少？', ['0','1','2','4'], 'B', '常数1的累积量等于区域面积，单位正方形面积为1。']),
  node('series', '级数与收敛', '微积分', [-520,390,-170], ['limits','integrals'], '研究无限项累加的趋势；这里的连线是学习建议，非严格逻辑依赖。', ['1/2+1/4+1/8+… 的和是多少？', ['1/2','1','2','无限大'], 'B', '这是首项1/2、公比1/2的等比级数，和为1。']),
  node('vectors', '向量与位移', '线性代数', [210,-285,60], ['arithmetic'], '用大小与方向描述位移，并联系数字表示。', ['把一个位移箭头平移到另一个起点，长度和方向保持不变，它表示的位移是否改变？', ['改变了长度','改变了方向','位移不变','一定变成零'], 'C', '作为自由位移，只要长度和方向不变，平移起点不改变它。']),
  node('coordinates', '坐标与数字表示', '线性代数', [300,-130,-70], ['vectors'], '在给定坐标系中，将箭头与有序数字对应。', ['平面向量(-2,1)表示怎样的移动？', ['向右2上1','向左2上1','向左1上2','向左2下1'], 'B', '第一分量-2表示向左2，第二分量1表示向上1。']),
  node('addition', '向量加法', '线性代数', [120,35,140], ['coordinates'], '首尾相接的移动与各方向分别累加描述同一总位移。', ['(2,1)+(-1,3) 的结果是什么？', ['(3,4)','(1,-2)','(1,4)','(-2,3)'], 'C', '两个方向分别相加，得到(1,4)。']),
  node('scaling', '数乘与缩放', '线性代数', [440,20,-100], ['coordinates'], '同一个标量作用于全部分量，联系伸缩与反向。', ['(2,-1)乘以-2，得到什么？', ['(-4,2)','(4,-2)','(-2,1)','(-4,-1)'], 'A', '两个分量都乘以-2，结果(-4,2)，整体反向且长度变为2倍。']),
  node('linear-combinations', '线性组合', '线性代数', [230,185,50], ['addition','scaling'], '把数乘与加法组合，用几个向量表达新的向量。', ['2(1,0)+3(0,1) 等于什么？', ['(3,2)','(2,3)','(5,5)','(1,1)'], 'B', '先分别缩放，再相加，得到(2,3)。']),
  node('basis', '基与维数', '线性代数', [100,350,150], ['linear-combinations'], '理解一组独立方向如何表示空间中的向量。', ['以下哪组向量能作为二维平面的基？', ['(1,0)与(2,0)','(0,0)与(1,1)','(1,0)与(0,1)','只有(1,0)'], 'C', '这两个独立方向可以线性组合出平面任意向量。']),
  node('matrices', '矩阵与运算', '线性代数', [520,190,-50], ['linear-combinations'], '用数字阵列组织线性运算，并理解列向量的作用。', ['单位矩阵 I 乘以向量(2,3)，结果是什么？', ['(0,0)','(3,2)','(2,3)','(4,6)'], 'C', '单位矩阵保持每个向量不变。']),
  node('linear-transformations', '线性变换', '线性代数', [400,360,60], ['basis','matrices'], '联系空间变换与矩阵作用；连线为建议学习顺序。', ['哪一种变换是线性的？', ['把每个点向右平移1','把每个向量乘以2','把每个向量加上(1,1)','把原点移动到(1,0)'], 'B', '整体乘以2保持向量加法和数乘，且保持原点。']),
  node('rank', '秩与线性方程', '线性代数', [680,360,180], ['matrices'], '研究独立方向的数量与线性方程的解。', ['矩阵两行分别为(1,2)和(2,4)，它的秩是多少？', ['0','1','2','4'], 'B', '第二行是第一行的2倍，只有一个独立方向，秩为1。']),
  node('determinants', '行列式', '线性代数', [590,535,-70], ['linear-transformations'], '用面积或体积的带符号缩放理解行列式。', ['二维对角矩阵diag(2,3)的行列式是多少？', ['5','6','1','0'], 'B', '对角矩阵的行列式为对角元素乘积2×3=6。']),
  node('inverse', '逆变换', '线性代数', [760,535,150], ['rank','linear-transformations'], '理解何时可以恢复变换前的向量。', ['将所有向量乘以2的变换，怎样撤销？', ['再乘2','乘以0','乘以1/2','加上2'], 'C', '再乘1/2，使总倍数为1。']),
  node('eigen', '特征值与方向', '线性代数', [350,705,30], ['determinants'], '寻找变换后仍留在同一直线上的非零向量。', ['矩阵diag(2,3)作用于(1,0)，对应的特征值是多少？', ['0','1','2','3'], 'C', '结果为(2,0)，等于原向量的2倍。']),
];
export const NODE_BY_ID = new Map(CATALOG.map((n) => [n.id, n]));
export function ancestors(id) {
  const result = new Set();
  const visit = (key) => { for (const parent of NODE_BY_ID.get(key)?.prerequisites || []) if (!result.has(parent)) { result.add(parent); visit(parent); } };
  visit(id); return result;
}
// 优先识别更具体的知识，避免“偏导数”误映射为普通导数等。
const MATCHERS = [
  ['double-integrals', /二重积分|double integral/i], ['partials', /偏导|partial derivative/i],
  ['eigen', /特征值|特征向量|eigen/i], ['determinants', /行列式|determinant/i], ['inverse', /逆变换|逆矩阵|inverse/i],
  ['rank', /矩阵的秩|秩与|线性方程|matrix rank/i], ['linear-transformations', /线性变换|linear transformation/i],
  ['basis', /基向量|一组基|基与|维数|basis/i], ['linear-combinations', /线性组合|linear combination/i],
  ['matrices', /矩阵|matrix|matrices/i], ['series', /级数|收敛|series/i], ['integrals', /积分|integral/i],
  ['derivatives', /导数|求导|变化率|derivative/i], ['limits', /极限|连续性|limit/i], ['functions', /函数|function/i],
  ['addition', /向量加法|向量.*相加|两段移动|两段.*位移|位移合成|首尾相接|合起来的位移|连续.*移动/i],
  ['scaling', /数乘|标量|缩放|向量.*乘以|乘以.*向量|scal/i], ['coordinates', /坐标|有序坐标|coordinate/i], ['vectors', /向量|箭头|vector/i],
];
export const matchKnowledge = (text) => MATCHERS.find(([, pattern]) => pattern.test(String(text)))?.[0] || null;

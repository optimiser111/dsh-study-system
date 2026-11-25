import {FOUNDATION_VERSION,FOUNDATION_PROMPT,FOUNDATION_PLAN_PROMPT,FOUNDATION_AUDIT_PROMPT,compactFoundationPlan,planErrors,foundationErrors,foundationFingerprint,auditErrors} from './foundations.js';
import {fillFoundationEvidence} from './foundation-evidence.js';

const fresh=s=>s?.content&&Date.now()-Date.parse(s.fetchedAt)<30*86400000;
const queries=value=>(Array.isArray(value)?value:[]).filter(q=>typeof q==='string'&&q.trim()&&q.length<=300).map(q=>q.trim()).slice(0,4);
const messages=value=>(Array.isArray(value)?value:[]).map(g=>typeof g==='string'?g:g?.reason||g?.message||JSON.stringify(g)).filter(Boolean).map(g=>g.slice(0,800));
const stageNames={planning:'规划基础链',retrieving:'补查教材定义',mapping:'连接基础与课程',auditing:'审核根基',incomplete:'基础尚有缺口',complete:'基础补全完成'};
const canonicalURL=value=>{const u=new URL(value);u.hash='';u.hostname=u.hostname.replace(/^www\./,'');return u.href;};
const directoryURL=url=>/\/pages\/(index|lecture-notes)\/?(?:\?|$)/i.test(url);

function excerpt(content,terms){
  if(content.length<=8000)return content;
  const words=[...new Set(terms.join(' ').toLowerCase().match(/[a-z]{4,}|[\p{Script=Han}]{2,}/gu)||[])].filter(w=>!['site','textbook','definition','prerequisite','fundamentals'].includes(w));
  const ranges=[[0,2200]];for(const word of words){const at=content.toLowerCase().indexOf(word,1800);if(at>=0)ranges.push([Math.max(0,at-650),Math.min(content.length,at+3500)]);if(ranges.length>=6)break;}
  ranges.sort((a,b)=>a[0]-b[0]);const merged=[];for(const r of ranges){if(merged.length&&r[0]<=merged.at(-1)[1])merged.at(-1)[1]=Math.max(merged.at(-1)[1],r[1]);else merged.push(r);}
  return merged.map(([a,b])=>content.slice(a,b)).join('\n[此处省略本页未提供的正文]\n').slice(0,16000);
}
function quoteErrors(graph,sources){return [...(graph.nodes||[]),...(graph.edges||[])].flatMap(item=>!item.support?.length?['缺少来源定义：'+(item.title||item.from+' → '+item.to)]:(item.support||[]).filter(e=>!e.quote?.trim()||!sources.some(s=>s.id===e.sourceId&&s.content.includes(e.quote.trim()))).map(()=> '引文无法核对：'+(item.title||item.from+' → '+item.to)));}
function expandEvidence(graph){
  const evidence=new Map();for(const e of graph.evidence||[]){if(evidence.has(e.id))throw Error('教材证据ID重复');evidence.set(e.id,{sourceId:e.sourceId,quote:e.quote});}
  for(const item of [...(graph.nodes||[]),...(graph.edges||[])])if(!item.support&&item.supportRefs)item.support=item.supportRefs.map(id=>evidence.get(id)||{sourceId:'missing',quote:''});
}
function compactGraph(graph){
  if(!graph)return undefined;const pool=new Map(),evidence=[];
  const compact=item=>{const {support,...rest}=item;return {...rest,supportRefs:(support||[]).map(s=>{const key=JSON.stringify([s.sourceId,s.quote]);if(!pool.has(key)){const id='e'+(evidence.length+1);pool.set(key,id);evidence.push({id,sourceId:s.sourceId,quote:s.quote});}return pool.get(key);})};};
  return {nodes:(graph.nodes||[]).map(compact),edges:(graph.edges||[]).map(compact),evidence,gaps:graph.gaps,queries:graph.queries};
}
function inferDefinitionSupport(graph){
  const nodes=new Map((graph.nodes||[]).map(n=>[n.id,n]));
  for(const e of graph.edges||[])if(['prerequisite','suggested-prerequisite'].includes(e.kind)&&e.support?.length&&e.support.every(s=>s.sourceId==='course-text')){
    const definitions=[...(nodes.get(e.from)?.support||[]),...(nodes.get(e.to)?.support||[])].filter(s=>s.sourceId!=='course-text');
    if(definitions.length){const seen=new Set(e.support.map(s=>JSON.stringify(s)));for(const s of definitions)if(!seen.has(JSON.stringify(s))){seen.add(JSON.stringify(s));e.support.push(s);}
      e.kind='suggested-prerequisite';e.reason='依据端点的外部定义与本课用法推理学习依赖，非教材明定顺序。'+(e.reason||'');
    }
  }
}

export async function buildDeepResearch(input,{web,model,signal,diagnostic=()=>{},checkpoint=async()=>{}},api){
  const {parseResearch:parse,CLASSIFY_PROMPT,MAP_PROMPT,sourceAuthority,pageText}=api;
  let classification,plan,graph,audit,sources=[],round=0,attemptQueries=[],gaps=[],nextQueries=[];
  const courseSource={id:'course-text',kind:'course-material',url:'urn:study-material:'+input.sessionId,title:'本次采集的学习材料',publisher:'本机采集',authority:'本次原材料，仅证明课程内容，不替代基础教材',content:input.text,fetchedAt:new Date().toISOString()};
  const allSources=()=>[...sources,courseSource];
  const saved=input.checkpoint?.foundationVersion===FOUNDATION_VERSION?input.checkpoint:null;
  const archive=new Map((saved?.sources||[]).filter(fresh).map(s=>[canonicalURL(s.url),s]));
  if(saved){({classification,plan,graph,audit}=saved);plan=compactFoundationPlan(plan);sources=(saved.sources||[]).filter(fresh);if(graph)inferDefinitionSupport(graph);}
  const sameAttempt=saved&&saved.attemptId===input.attemptId;
  if(sameAttempt){round=Math.min(3,saved.round||0);attemptQueries=saved.attemptQueries||[];}
  const at=async(stage,task)=>{try{signal?.throwIfAborted();return await task();}catch(e){e.researchStage=stage;throw e;}};
  const report=async stage=>{
    const state={foundationVersion:FOUNDATION_VERSION,attemptId:input.attemptId,attemptQueries,classification,plan,graph,audit,sources,round:Math.min(round,3),stage,stageLabel:stageNames[stage],gaps:gaps.slice(0,20),nextQueries};
    diagnostic({...state,classification,sources,graph});await checkpoint(state);
  };
  try{
    if(!web?.search||!web?.fetch)throw Error('联网搜索或来源读取尚未就绪');
    if(sameAttempt&&saved.stage==='incomplete'&&round>=3)throw Error('本轮基础补查额度已用完，已保留进度；请点击继续补全基础开启下一轮。');
    classification??=parse(await at('classification',()=>model(CLASSIFY_PROMPT,JSON.stringify({title:input.title,sourceKind:input.sourceKind,lessonSummary:input.lessonSummary,text:input.text.slice(0,18000),subjects:input.subjects}),signal)));
    if(!classification.subject||!classification.reason?.trim()||!Number.isFinite(classification.confidence)||classification.confidence<0||classification.confidence>1)throw Error('课程归属结果无效');
    if(!plan||planErrors(plan,input.lessonSummary).length){
      await report('planning');
      const context={classification,lessonSummary:input.lessonSummary,text:input.text.slice(0,18000),existingConcepts:(input.maps||[]).flatMap(m=>m.nodes.map(({subject,title})=>({subject,title}))).slice(0,120)};
      plan=compactFoundationPlan(parse(await at('planning',()=>model(FOUNDATION_PLAN_PROMPT,JSON.stringify(context),signal))));
      if(planErrors(plan,input.lessonSummary).length)plan=compactFoundationPlan(parse(await at('planning',()=>model(FOUNDATION_PLAN_PROMPT+'\n修正以下结构和根基错误，不能缩小课程范围。',JSON.stringify({...context,previous:plan,errors:planErrors(plan,input.lessonSummary)}),signal))));
      if(planErrors(plan,input.lessonSummary).length)throw Error('基础规划尚未完成：'+planErrors(plan,input.lessonSummary).join('；'));
      await report('planning');
    }
    // Reuse readable texts, never reuse a previous graph's self-declared roots.
    // Directory/metadata pages and www aliases must not consume the saved
    // source budget. Keep IDs stable for all retained supporting quotations.
    const usable=s=>!directoryURL(s.url)&&!(/\/items\/[^/]+\/full(?:[?#]|$)/.test(s.url)&&/dc\.contributor|dc\.identifier/.test(s.content));
    sources=[...new Map(sources.filter(usable).map(s=>[canonicalURL(s.url),s])).values()];
    if(sources.length>16&&graph){const used=new Set([...(graph.nodes||[]),...(graph.edges||[])].flatMap(n=>(n.support||[]).map(s=>s.sourceId)));sources=sources.filter(s=>used.has(s.id));}
    const cached=[...(input.previous?.foundationVersion===FOUNDATION_VERSION?input.previous.sources:[]),...(input.maps||[]).filter(m=>m.subject===classification.subject&&m.foundationVersion===FOUNDATION_VERSION).flatMap(m=>m.sources||[])].filter(s=>s.id!=='course-text').filter(fresh).filter(usable);
    const nextSourceId=()=>'s'+(1+Math.max(0,...sources.map(s=>Number(s.id?.replace(/^s/,''))||0)));
    for(const s of cached)if(sources.length<40&&!sources.some(p=>canonicalURL(p.url)===canonicalURL(s.url)))sources.push({...s,id:nextSourceId()});
    nextQueries=queries(saved?.nextQueries?.length?saved.nextQueries:audit?.queries||graph?.queries||plan.queries);
    const fetched=new Set(sources.map(s=>canonicalURL(s.url)));
    const startRound=sameAttempt?Math.max(1,round):1;
    for(round=startRound;round<=3;round++){
      if(sources.length>=20&&graph&&gaps.length){const used=new Set([...(graph.nodes||[]),...(graph.edges||[])].flatMap(n=>(n.support||[]).map(s=>s.sourceId)));sources=sources.filter(s=>used.has(s.id)||(input.sourceHints||[]).includes(s.url));fetched.clear();for(const s of sources)fetched.add(canonicalURL(s.url));}
      const reuseGraph=graph&&!graph.gaps?.length&&graph.foundationAudit?.passed!==false&&quoteErrors(graph,allSources()).length===0&&foundationErrors(graph,input.lessonSummary,{requireAudit:false}).length===0;
      await report('retrieving');
      const currentQueries=reuseGraph?[]:nextQueries.filter(q=>!attemptQueries.includes(q)).slice(0,4);attemptQueries.push(...currentQueries);
      const results=await Promise.allSettled(currentQueries.map(query=>at('search',()=>web.search({query,maxResults:5},signal))));signal?.throwIfAborted();
      const candidates=new Map();
      for(const hint of input.sourceHints||[])if(sourceAuthority(hint))candidates.set(hint,{url:hint,title:hint});
      for(let rank=0;rank<5;rank++)for(const result of results)if(result.status==='fulfilled'){
        const s=result.value?.sources?.[rank];if(s&&sourceAuthority(s.url)){const u=new URL(s.url);u.hash='';if(!directoryURL(u.href))candidates.set(canonicalURL(u.href),{...s,url:u.href});}
      }
      for(const r of results)if(r.status==='rejected'&&/insufficient balance|额度不足|HTTP 40[123]/i.test(r.reason?.message||''))throw r.reason;
      if(!sources.length&&!candidates.size)throw results.find(r=>r.status==='rejected')?.reason||Error('尚未找到可读取的教材定义');
      // Limit each round's reads, not conceptual depth. Incomplete work is saved
      // and can resume; it is never relabelled complete when the budget runs out.
      const selected=[...candidates.values()].filter(s=>{
        const existing=sources.find(p=>canonicalURL(p.url)===canonicalURL(s.url));
        return (!fetched.has(canonicalURL(s.url))&&sources.length<40)||existing?.content.length>=16000&&existing.extractor!=='main-v3';
      }).slice(0,8);
      for(let i=0;i<selected.length;i+=3){
        const pages=await Promise.allSettled(selected.slice(i,i+3).map(async candidate=>{
          const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
          const cached=archive.get(canonicalURL(candidate.url));if(cached?.extractor==='main-v3')return cached;
          const page=await web.fetch({url:candidate.url},requestSignal),url=page.url||candidate.url,authority=sourceAuthority(url),content=pageText(page.body,64000);
          if(!authority||content.length<120||page.statusCode<200||page.statusCode>=300||!Number.isInteger(page.statusCode))return null;
          return {url,title:candidate.title||url,publisher:new URL(url).hostname,authority,content,extractor:'main-v3',fetchedAt:new Date().toISOString()};
        }));
        signal?.throwIfAborted();
        for(const r of pages){
          if(r.status==='fulfilled'&&r.value){
            const url=canonicalURL(r.value.url),index=sources.findIndex(s=>canonicalURL(s.url)===url);archive.set(url,r.value);
            if(index>=0){
              const old=sources[index],quotes=[...(graph?.nodes||[]),...(graph?.edges||[])].flatMap(n=>(n.support||[]).filter(s=>s.sourceId===old.id).map(s=>s.quote));
              if(quotes.every(q=>r.value.content.includes(q.trim())))sources[index]={...r.value,id:old.id};
            }else if(sources.length<40){fetched.add(url);sources.push({...r.value,id:nextSourceId()});}
          }else if(r.status==='rejected'&&/insufficient balance|额度不足/.test(r.reason?.message||''))throw r.reason;
        }
      }
      if(!sources.length)throw Error('尚未找到可读取的教材定义');
      const context=()=>({classification,foundationPlan:plan,lessonSummary:input.lessonSummary,sourceKind:input.sourceKind,existingConcepts:(input.maps||[]).flatMap(m=>m.nodes.map(({subject,title})=>({subject,title}))).slice(0,120),sources:allSources().map(s=>({...s,content:s.id==='course-text'?s.content.slice(0,18000):excerpt(s.content,[...currentQueries,...plan.concepts.map(c=>c.title)])})),previous:compactGraph(graph),errors:gaps});
      await report('mapping');
      if(!reuseGraph){
        if(plan.concepts.length>24)graph=await at('mapping',()=>fillFoundationEvidence(plan,{previous:graph,input,sources:allSources(),context:context(),model,signal,onProgress:async partial=>{graph={...partial,foundationPlan:plan};await report('mapping');}}));
        else graph=parse(await at('mapping',()=>model(MAP_PROMPT+'\n'+FOUNDATION_PROMPT,JSON.stringify(context()),signal)));
      }graph.foundationPlan=plan;
      expandEvidence(graph);
      // Plan learningTargetIds may say "supports this goal". Only the actual
      // course target node receives the evidence mapping used by the panel.
      for(const n of graph.nodes||[]){
        n.learningTargetIds=n.courseQuote?(plan.targets||[]).filter(t=>n.planConceptIds?.includes(t.conceptId)).map(t=>t.targetId):[];
        if(n.planConceptIds?.length===1){const c=plan.concepts.find(c=>c.id===n.planConceptIds[0]);if(c)n.title=c.title;}
      }
      inferDefinitionSupport(graph);
      gaps=[...new Set([...foundationErrors(graph,input.lessonSummary,{requireAudit:false}),...quoteErrors(graph,allSources()),...messages(graph.gaps)])];
      if(!gaps.length){
        await report('auditing');
        const auditContext=context();delete auditContext.previous;
        audit=parse(await at('auditing',()=>model(FOUNDATION_AUDIT_PROMPT,JSON.stringify({...auditContext,graph:compactGraph(graph)}),signal)));
        graph.foundationAudit={...audit,graphHash:foundationFingerprint(graph)};
        gaps=auditErrors(graph);
        if(!gaps.length){await report('complete');return {...graph,subject:classification.subject,area:classification.area,confidence:classification.confidence,reason:classification.reason,key:input.key,sources:allSources(),foundationVersion:FOUNDATION_VERSION};}
        if(audit.expandConcepts?.length){
          const updated=new Map(plan.concepts.map(c=>[c.id,c]));for(const c of audit.expandConcepts)updated.set(c.id,c);
          const expanded=compactFoundationPlan({...plan,concepts:[...updated.values()]});
          const errors=planErrors(expanded,input.lessonSummary);if(errors.length)gaps.push(...errors);else plan=expanded;
        }
      }
      nextQueries=queries(audit?.queries?.length?audit.queries:graph.queries);
      // A dedicated gap planner sees concrete failures and plans a NEW search,
      // unlike the old single rewrite on exactly the same insufficient texts.
      if(!nextQueries.length||nextQueries.every(q=>attemptQueries.includes(q))){
        const repair=parse(await at('planning',()=>model(FOUNDATION_PLAN_PROMPT+'\n针对errors给出新的教材检索queries。可以通过expandConcepts新增必要原语或修正原有parents/level；不得删除已有概念。返回 {queries,expandConcepts}。',JSON.stringify({classification,foundationPlan:plan,errors:gaps,previousQueries:attemptQueries}),signal)));
        nextQueries=queries(repair.queries);
        if(repair.expandConcepts?.length){const updated=new Map(plan.concepts.map(c=>[c.id,c]));for(const c of repair.expandConcepts)updated.set(c.id,c);const expanded=compactFoundationPlan({...plan,concepts:[...updated.values()]});if(!planErrors(expanded,input.lessonSummary).length)plan=expanded;}
      }
      audit=null;
      await checkpoint({foundationVersion:FOUNDATION_VERSION,attemptId:input.attemptId,attemptQueries,classification,plan,graph,sources,stage:'incomplete',stageLabel:stageNames.incomplete,round,gaps:gaps.slice(0,20),nextQueries});
    }
    throw Error('基础尚未补全：'+gaps.slice(0,4).join('；')+'。已保留进度，可继续补全。');
  }catch(error){
    gaps=[...new Set([...gaps,String(error.message)])];
    await report('incomplete').catch(()=>{});throw error;
  }
}

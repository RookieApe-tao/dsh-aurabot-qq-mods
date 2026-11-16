// Human-facing names only. Storage keys and privacy scopes never change here.
export const SOURCE_NAMES=Object.freeze({autotelic:'自主活动',night:'睡眠与梦境',meme:'表情制作',beliefs:'观点与想法','file-inbox':'私聊文件','smart-search':'联网搜索','persona-memory':'记忆整理','autotelic-screen':'自主浏览',contacts:'联系人互动','meme-wiki':'梗百科','rss-reader':'资讯浏览',bili:'B站互动',song:'唱歌','qzone-social':'空间互动',imagegen:'图片创作',stickers:'表情互动',diary:'空间日记',voice:'语音互动','character-photo':'角色照片',stardew:'星露谷',douyin:'抖音互动',xhs:'小红书互动',purpose:'目标与计划',mood:'心情'})
export function describeScope(scope,profile={}){
 const category=scope.audience==='system'?'角色经历':scope.audience==='group'?'群聊':'私聊'
 const name=scope.audience==='system'?(SOURCE_NAMES[String(scope.subject).split(':')[0]]||'其他玩法经历'):(profile.name||profile.nickname||profile.alias||(scope.audience==='group'?'群 ':'QQ ')+scope.subject)
 return {displayName:name,displayLabel:category+' · '+name}
}

export const ORGANIZER_ERRORS = Object.freeze({
  limit: '整理输出达到单次上限，回复未完整返回',
  empty: '整理模型未返回正文',
  format: '整理模型未返回完整的 JSON',
  shape: '摘要格式不合法',
})

export function organizerFailureSummary(rows) {
  const reasons = new Map()
  for (const row of rows) {
    const error = row.error || ''
    const incomplete = /unexpected end|unterminated|end of (?:json|data)/i.test(error)
    const reachedLimit = row.output_actual != null && row.output_reserved > 0
      && row.output_actual >= row.output_reserved
    let label = '其他整理失败'
    if (row.status === 'unknown') label = '请求结果未知'
    else if (error.includes('达到单次上限') || (incomplete && reachedLimit)) label = '输出达到单次上限，回复未完整返回'
    else if (error === ORGANIZER_ERRORS.empty) label = '模型没有返回整理正文'
    else if ([ORGANIZER_ERRORS.format, ORGANIZER_ERRORS.shape].includes(error)
      || incomplete || /not valid JSON|Unexpected token/i.test(error)) label = '模型回复格式不完整'
    else if (/来源不属于|来源已被人工更正|此范围或人物已停止记录/.test(error)) label = '来源已变化或已停止记录'
    else if (/来源|必须保留原话|事实值未|约定状态/.test(error)) label = '整理结果未通过来源校验'
    reasons.set(label, (reasons.get(label) || 0) + Number(row.count ?? 1))
  }
  return [...reasons].map(([label, count]) => ({ label, count })).sort((a,b)=>b.count-a.count)
}

export function queueHealth(queue=[],budget={}){
 const n=status=>queue.filter(x=>x.status===status).reduce((sum,x)=>sum+Number(x.count??x.n??0),0)
 const failed=n('failed'),unknown=n('unknown'),paused=n('paused'),pending=n('pending'),running=n('running'),stale=n('stale')
 const issues=[]
 if(failed)issues.push(`${failed}项整理失败`)
 if(unknown)issues.push(`${unknown}项结果未知`)
 if(stale)issues.push(`${stale}项来源或运行状态已变化`)
 if(budget.oversized)issues.push(`${budget.oversized}条长内容待整理`)
 if(budget.unavailableSources)issues.push(`${budget.unavailableSources}条长内容原文已不可用`)
 if(budget.monthlyBlocked)issues.push(`${budget.monthlyBlocked}项月概括需分批`)
 const waiting=budget.waiting?.length||0,oldest=Math.min(...queue.filter(x=>['pending','running','failed','unknown','paused'].includes(x.status)).map(x=>Number(x.oldest)||Infinity))
 return {failed,unknown,paused,pending,running,stale,waiting,attention:issues.length>0,oldest:Number.isFinite(oldest)?oldest:null,message:issues.length?issues.join('；')+'。已保留可用来源，请在高级设置中检查整理任务。':waiting?'部分整理等待额度恢复。':paused?`${paused}项整理已暂停，恢复增强后继续。`:pending||running?`待整理${pending}项，正在处理${running}项。`:'目前没有待处理的增强整理任务。'}
}

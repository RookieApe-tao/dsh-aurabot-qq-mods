// Supported DSH usage separates uncached input, cache read and cache write.
// outputTokens already includes reasoning; never add reasoning a second time.
export const categorySQL = category => category === 'chat' ? "category='chat'" : category === 'gameplay' ? "category='gameplay'" : category === 'native' ? "category='native-memory'" : "category NOT IN ('chat','gameplay','native-memory')"
export const inputSQL = "CASE WHEN state='complete' AND input_actual IS NOT NULL AND output_actual IS NOT NULL THEN input_actual ELSE MAX(input_reserved,COALESCE(input_actual,0)) END"
export const outputSQL = "CASE WHEN state='complete' AND input_actual IS NOT NULL AND output_actual IS NOT NULL THEN output_actual ELSE MAX(output_reserved,COALESCE(output_actual,0)) END"
export function finalUsage(usage={}) {
  const valid=n=>Number.isSafeInteger(n)&&n>=0
  for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'])if(usage[k]!=null&&!valid(usage[k]))throw Error('无效实际用量')
  const input=usage.inputTokens==null?null:usage.inputTokens+(usage.cacheReadTokens||0)+(usage.cacheWriteTokens||0)
  if(input!==null&&!valid(input))throw Error('无效实际用量')
  return {input,output:usage.outputTokens??null}
}
export const nextBudgetDay = now => Math.floor((now+8*3600000)/86400000)*86400000+86400000-8*3600000

// 「抖音私信分享卡片后再补一句话」的设置。放在模块自己的设置里（config.ext.douyin），
// 不塞进插件核心的 douyin 配置：老用户升级时默认不开，行为完全不变。

export const SHARE_TEXT_DEFAULTS = {
  shareDmText: false, // 关：只发视频卡片（和以前一样）
  shareDmTextChance: 0.6, // 开的时候每张卡片后面带话的概率
  shareDmTextRetry: false, // 发送结果不确定（可能已发出）时是否重试：默认不重试，避免重复
}

export const SHARE_TEXT_SETTINGS = [
  { key: 'shareDmText', label: '抖音私信里卡片后补一句', type: 'switch', hint: '分享到抖音私信时，先发视频卡片，再跟一句她自己想说的话。默认关。' },
  { key: 'shareDmTextChance', label: '带话概率', type: 'number', min: 0, max: 1, step: 0.05, hint: '0～1，1 = 每次都带。只在上面开关打开时生效。' },
  { key: 'shareDmTextRetry', label: '发送结果不确定时重试一次', type: 'switch', hint: '默认不重试：私信可能已经发出，再试会重复。只有确实没发出去才建议打开。' },
]

const clamp01 = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : SHARE_TEXT_DEFAULTS.shareDmTextChance
}

/** 把面板里可能存成字符串 / 缺省的值收成稳定类型。 */
export function normalizeShareTextOptions(value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    shareDmText: typeof v.shareDmText === 'boolean' ? v.shareDmText : SHARE_TEXT_DEFAULTS.shareDmText,
    shareDmTextChance: clamp01(v.shareDmTextChance),
    shareDmTextRetry: typeof v.shareDmTextRetry === 'boolean' ? v.shareDmTextRetry : SHARE_TEXT_DEFAULTS.shareDmTextRetry,
  }
}

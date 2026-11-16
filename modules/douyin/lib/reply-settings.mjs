// 「评论区接着聊」的模块设置。默认关：这是新增的公开评论动作，老用户升级时行为不变。

export const COMMENT_REPLY_DEFAULTS = {
  commentReply: false, // 主人在她 @ 过的评论下回复后，要不要接一句
  commentReplyPollMinutes: 5, // 隔几分钟看一次那些评论的回复
}

export const COMMENT_REPLY_SETTINGS = [
  { key: 'commentReply', label: '评论区接着聊', type: 'switch', hint: '她在评论里 @ 过你、你回复那条评论之后，她会看到并用自己的口气接一句（新评论里真 @ 你）。默认关。' },
  { key: 'commentReplyPollMinutes', label: '多久看一次评论回复', type: 'number', min: 1, max: 60, step: 1, hint: '分钟。只在上面开关打开时生效。' },
]

/** 面板可能存成字符串 / 缺省：收成稳定类型。 */
export function normalizeCommentReplyOptions(value) {
  const v = value && typeof value === 'object' ? value : {}
  const minutes = Number(v.commentReplyPollMinutes)
  return {
    commentReply: typeof v.commentReply === 'boolean' ? v.commentReply : COMMENT_REPLY_DEFAULTS.commentReply,
    commentReplyPollMinutes: Number.isFinite(minutes) ? Math.min(60, Math.max(1, Math.round(minutes))) : COMMENT_REPLY_DEFAULTS.commentReplyPollMinutes,
  }
}

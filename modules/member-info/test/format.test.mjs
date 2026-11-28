// 纯函数单测：不联网、不需要 Aurabot，直接 `node --test test/`。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { roleText, fmtTime, fmtAgo, fmtYears, formatMember } from '../lib/format.mjs'
import { toId, describeError } from '../lib/query.mjs'

test('roleText：三种角色翻成中文，未知角色原样返回', () => {
  assert.equal(roleText('owner'), '群主')
  assert.equal(roleText('admin'), '管理员')
  assert.equal(roleText('member'), '普通成员')
  assert.equal(roleText('weird'), 'weird')
  assert.equal(roleText(''), '身份未知')
})

test('fmtTime：秒转本地时间，0 和非法值返回空串', () => {
  // 用固定时间戳：2024-01-01 00:00:00 UTC 附近，只断言格式不依赖时区
  const s = fmtTime(1704067200)
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(fmtTime(0), '')
  assert.equal(fmtTime(-1), '')
  assert.equal(fmtTime('abc'), '')
})

test('fmtAgo：分钟/小时/天/月/年逐级进位', () => {
  const now = Date.now()
  const ago = (sec) => fmtAgo(Math.floor((now - sec * 1000) / 1000), now)
  assert.equal(ago(10), '刚刚')
  assert.equal(ago(300), '5 分钟前')
  assert.equal(ago(7200), '2 小时前')
  assert.equal(ago(86400 * 3), '3 天前')
  assert.equal(ago(86400 * 65), '2 个月前')
  assert.equal(ago(86400 * 400), '1 年前')
  assert.equal(fmtAgo(0, now), '')
})

test('fmtYears：只认正数', () => {
  assert.equal(fmtYears(7), '7 年')
  assert.equal(fmtYears(7.8), '7 年')
  assert.equal(fmtYears(0), '')
  assert.equal(fmtYears('x'), '')
})

test('toId：正整数才通过，字符串能转', () => {
  assert.equal(toId('12345'), 12345)
  assert.equal(toId(12345), 12345)
  assert.equal(toId(' 123 '), 123)
  assert.equal(toId('abc'), 0)
  assert.equal(toId('-5'), 0)
  assert.equal(toId('0'), 0)
  assert.equal(toId(null), 0)
})

test('describeError：常见错误翻成人话', () => {
  assert.match(describeError(new Error('not found')), /没有这个人/)
  assert.match(describeError(new Error('permission denied')), /没权限/)
  assert.match(describeError(new Error('timeout')), /没响应/)
  assert.equal(describeError(new Error('')), '未知错误')
})

test('formatMember：完整资料拼成多行，含身份/加群/最后发言', () => {
  const info = {
    user_id: 1591261865,
    nickname: '梓晨',
    card: '',
    role: 'admin',
    title: '狗修金sam',
    join_time: 1700000000,
    last_sent_time: 1700100000,
    level: '11',
    qage: 7,
    qq_level: 47,
    shut_up_timestamp: 0,
  }
  const text = formatMember(info, { group: { group_name: '测试群' }, now: 1700200000000 })
  assert.match(text, /【梓晨】1591261865/)
  assert.match(text, /身份：管理员（头衔「狗修金sam」）/)
  assert.match(text, /群：测试群/)
  assert.match(text, /加群：/)
  assert.match(text, /Q 龄 7 年/)
  assert.match(text, /QQ 等级 47/)
  assert.match(text, /群等级：11/)
  assert.match(text, /最后发言：/)
  assert.doesNotMatch(text, /禁言/)
})

test('formatMember：关掉 Q 龄和最后发言后不出现这两行', () => {
  const info = {
    user_id: 1, nickname: '甲', role: 'member',
    join_time: 1700000000, last_sent_time: 1700100000, qage: 7, qq_level: 47, level: '3',
  }
  const text = formatMember(info, { showLastSend: false, showQAge: false, now: 1700200000000 })
  assert.doesNotMatch(text, /Q 龄/)
  assert.doesNotMatch(text, /最后发言/)
  assert.match(text, /群等级：3/)
})

test('formatMember：名片和昵称不同就都写出来；没名片用昵称', () => {
  const base = { user_id: 2, role: 'member', join_time: 1700000000 }
  const withCard = formatMember({ ...base, nickname: '小明', card: '三年二班小明' })
  assert.match(withCard, /【三年二班小明】2/)
  assert.match(withCard, /昵称：小明/)

  const noCard = formatMember({ ...base, nickname: '小明', card: '' })
  assert.match(noCard, /【小明】2/)
  assert.doesNotMatch(noCard, /昵称：/)
})

test('formatMember：禁言中会标出来', () => {
  const text = formatMember({ user_id: 3, nickname: '丙', role: 'member', shut_up_timestamp: 1700200000 })
  assert.match(text, /禁言中/)
})

test('formatMember：空资料返回空串，不编造', () => {
  assert.equal(formatMember(null), '')
  assert.equal(formatMember({}), '')
})

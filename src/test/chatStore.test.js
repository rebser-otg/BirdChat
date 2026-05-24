import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { chatStore } from '../lib/chatStore.js'

beforeEach(() => {
  chatStore.clear()
})

describe('chatStore', () => {
  it('starts empty', () => {
    expect(get(chatStore)).toEqual([])
  })

  it('push adds a message with ts, mine, and id fields', () => {
    chatStore.push({ name: 'Robin', text: 'hello', mine: true })
    const msgs = get(chatStore)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].name).toBe('Robin')
    expect(msgs[0].text).toBe('hello')
    expect(msgs[0].mine).toBe(true)
    expect(typeof msgs[0].ts).toBe('number')
    expect(typeof msgs[0].id).toBe('number')
  })

  it('assigns unique ids to each message', () => {
    chatStore.push({ name: 'Robin', text: 'a', mine: true })
    chatStore.push({ name: 'Wren', text: 'b', mine: false })
    const msgs = get(chatStore)
    expect(msgs[0].id).not.toBe(msgs[1].id)
  })

  it('push appends in order', () => {
    chatStore.push({ name: 'Robin', text: 'first', mine: true })
    chatStore.push({ name: 'Wren', text: 'second', mine: false })
    const msgs = get(chatStore)
    expect(msgs[0].text).toBe('first')
    expect(msgs[1].text).toBe('second')
  })

  it('messages are immutable between pushes', () => {
    chatStore.push({ name: 'Robin', text: 'a', mine: true })
    const snapshot = get(chatStore)
    chatStore.push({ name: 'Wren', text: 'b', mine: false })
    expect(snapshot).toHaveLength(1) // original snapshot unchanged
  })

  it('clear empties the store', () => {
    chatStore.push({ name: 'Robin', text: 'hello', mine: true })
    chatStore.clear()
    expect(get(chatStore)).toEqual([])
  })
})

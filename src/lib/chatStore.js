import { writable } from 'svelte/store'

function createChatStore() {
  let _msgId = 0
  const { subscribe, update, set } = writable([])

  return {
    subscribe,
    /**
     * Append a message. ts is set to Date.now() automatically.
     * @param {{ name: string, text: string, mine: boolean }} message
     */
    push(message) {
      update(msgs => [...msgs, { ...message, ts: Date.now(), id: ++_msgId }])
    },
    /** Remove all messages. */
    clear() {
      set([])
    }
  }
}

export const chatStore = createChatStore()

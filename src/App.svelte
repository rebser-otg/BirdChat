<script>
  import { onDestroy, tick } from 'svelte'
  import { chatStore } from './lib/chatStore.js'
  import { init, encode, startListening, stopListening } from './lib/acousticEngine.js'
  import { play } from './lib/birdSynth.js'
  import { pack, MAX_TEXT_LENGTH } from './lib/messageCodec.js'
  import './app.css'

  // --- State ---
  let senderName = $state(localStorage.getItem('birdchat_name') || 'Bird')
  let inputText = $state('')
  let micError = $state('')
  let initError = $state('')
  let sending = $state(false)
  let chatEl = $state(null)

  // Shared AudioContext — created on first user gesture (browser autoplay policy)
  let audioCtx = null
  let engineReady = false
  let micListening = false

  // Persist name to localStorage
  $effect(() => {
    localStorage.setItem('birdchat_name', senderName)
  })

  // Auto-scroll to bottom when new messages arrive
  $effect(() => {
    const msgs = $chatStore
    tick().then(() => {
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight
    })
  })

  // Derived
  const textTooLong = $derived(inputText.length > MAX_TEXT_LENGTH)
  const canSend = $derived(inputText.trim().length > 0 && !textTooLong && !sending)
  const messages = $derived($chatStore)

  async function ensureAudio() {
    if (!engineReady) {
      audioCtx = new AudioContext({ sampleRate: 48000 })
      try {
        await init()
      } catch (err) {
        initError = '⚠️ Failed to load audio engine. Please reload the page.'
        audioCtx.close()
        audioCtx = null
        return
      }
      engineReady = true
    }

    if (!micListening) {
      try {
        await startListening(audioCtx, (msg) => {
          chatStore.push({ ...msg, mine: false })
        })
        micListening = true
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          micError = "🎙 Microphone access denied — others can't send to you, but you can still tweet."
        } else {
          micError = `🎙 Microphone error: ${err.message}`
        }
      }
    }
  }

  async function sendMessage() {
    if (!canSend) return
    sending = true
    try {
      await ensureAudio()
      if (initError) return  // audio engine failed to load
      const name = senderName.trim() || 'Bird'
      const text = inputText.trim()
      const packed = pack({ name, text })
      const pcm = encode(packed)
      if (audioCtx.state === 'suspended') await audioCtx.resume()
      play(pcm, audioCtx)
      chatStore.push({ name, text, mine: true })
      inputText = ''
    } catch (err) {
      console.error('Send failed:', err)
    } finally {
      sending = false
    }
  }

  function onKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  onDestroy(() => {
    stopListening()
    audioCtx?.close()
  })
</script>

<div id="app">
  <!-- Header -->
  <header class="header">
    <span class="logo">🐦</span>
    <h1>BirdChat</h1>
    <input
      class="name-input"
      type="text"
      placeholder="Your bird name"
      maxlength="16"
      bind:value={senderName}
    />
  </header>

  <!-- Init error (ggwave WASM failure) — blocking -->
  {#if initError}
    <div class="error-banner" style="font-size:0.9rem; padding: 20px 16px">
      {initError}
      <br/><button onclick={() => location.reload()} style="margin-top:8px; padding:6px 14px; border-radius:6px; border:none; cursor:pointer;">Reload</button>
    </div>
  {/if}

  <!-- Mic error banner -->
  {#if micError}
    <div class="error-banner">{micError}</div>
  {/if}

  <!-- Chat bubbles -->
  <main class="chat" bind:this={chatEl}>
    {#each messages as msg (msg.id)}
      <div class="bubble-row {msg.mine ? 'mine' : 'theirs'}">
        <div class="bubble">
          {#if !msg.mine}
            <div class="sender">🐦 {msg.name}</div>
          {/if}
          <div class="msg-text">{msg.text}</div>
        </div>
      </div>
    {/each}
  </main>

  <!-- Char counter -->
  {#if inputText.length > MAX_TEXT_LENGTH * 0.8}
    <div class="char-count {textTooLong ? 'warn' : ''}">
      {inputText.length}/{MAX_TEXT_LENGTH}
    </div>
  {/if}

  <!-- Footer input -->
  <footer class="footer">
    <textarea
      class="text-input"
      placeholder="Type a message…"
      rows="1"
      bind:value={inputText}
      onkeydown={onKeydown}
    ></textarea>
    <button class="tweet-btn" onclick={sendMessage} disabled={!canSend}>
      Tweet 🐦
    </button>
  </footer>
</div>

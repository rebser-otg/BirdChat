<script>
  import { onDestroy, tick } from 'svelte'
  import { chatStore } from './lib/chatStore.js'
  import { init, encode, startListening, stopListening } from './lib/acousticEngine.js'
  import { play } from './lib/birdSynth.js'
  import { pack, MAX_TEXT_LENGTH } from './lib/messageCodec.js'
  import './app.css'

  // Build version (injected at build time) — lets you confirm the latest code is live
  const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

  // --- State ---
  let senderName = $state(localStorage.getItem('birdchat_name') || 'Bird')
  let inputText = $state('')
  let micError = $state('')
  let initError = $state('')
  let sending = $state(false)
  let chatEl = $state(null)

  // Live mic/decoder diagnostics (helps debug real-world reception on-device)
  let micLevel = $state(0)        // smoothed mic input RMS
  let diagEvents = $state([])     // recent decoder events (newest first)
  let listening = $state(false)   // mic actively capturing

  function handleDiag(d) {
    if (d.kind === 'level') {
      // Peak meter with decay so the bar is readable
      micLevel = Math.max(d.rms, micLevel * 0.85)
    } else if (d.kind === 'event') {
      let label
      if (d.name === 'frame-score') {
        const b = d.detail.bands
        // per-band match strength — reveals whether ALL 4 bands survive or some are dead
        label = `📶 signal ${d.detail.total} [B0:${b[0]} B1:${b[1]} B2:${b[2]} B3:${b[3]}] (need ≥1500)`
      } else {
        label = {
          'preamble':      '🔔 preamble detected',
          'len':           `📏 length = ${d.detail} bytes`,
          'frame':         '▫️ data frame',
          'decoded':       `✅ decoded ${d.detail} bytes`,
          'checksum-fail': '❌ checksum failed (partial signal)',
        }[d.name] || d.name
      }
      const t = new Date().toLocaleTimeString()
      diagEvents = [`${t}  ${label}`, ...diagEvents].slice(0, 20)
    }
  }

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
        await init(audioCtx.sampleRate)  // use the actual rate — iOS may give 44100 not 48000
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
        }, handleDiag)
        micListening = true
        listening = true
        micError = ''
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          micError = "🎙 Microphone access denied — others can't send to you, but you can still tweet."
        } else if (err.name === 'NotFoundError') {
          micError = "🎙 No microphone found — this device can still send tweets, but can't receive them."
        } else {
          micError = `🎙 Microphone error: ${err.message}`
        }
      }
    }
  }

  // Start receiving without having to send first (mic needs a user gesture).
  async function startListen() {
    await ensureAudio()
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

  <!-- Listen prompt — mic needs a user gesture, and the app must be listening
       to receive (it no longer auto-starts only on send). -->
  {#if !listening && !initError}
    <button class="listen-btn" onclick={startListen}>🎧 Tap to listen for tweets</button>
  {/if}

  <!-- Live diagnostics: confirms the mic is hearing the chirps and shows decode events -->
  {#if listening}
    <div class="diag">
      <div class="diag-level">
        <span class="diag-label">🎙 mic</span>
        <div class="level-bar">
          <div class="level-fill" style="width:{Math.min(100, micLevel * 1000)}%"></div>
        </div>
        <span class="diag-val">{micLevel.toFixed(3)}</span>
      </div>
      {#if diagEvents.length}
        <div class="diag-events">
          {#each diagEvents as ev}<div class="diag-event">{ev}</div>{/each}
        </div>
      {:else}
        <div class="diag-hint">Listening… play a tweet from another device.</div>
      {/if}
    </div>
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

  <!-- Build version — verify the device is running the latest deployed code -->
  <div class="version">v {VERSION}</div>
</div>

<style>
  .listen-btn {
    margin: 10px 16px;
    padding: 12px;
    border: none;
    border-radius: 10px;
    background: #3d7a3d;
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }
  .diag {
    margin: 8px 16px;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.25);
    border-radius: 10px;
    font-size: 0.8rem;
    color: #cde3cd;
  }
  .diag-level {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .diag-label { white-space: nowrap; }
  .diag-val {
    font-variant-numeric: tabular-nums;
    min-width: 3.2em;
    text-align: right;
    opacity: 0.8;
  }
  .level-bar {
    flex: 1;
    height: 8px;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    overflow: hidden;
  }
  .level-fill {
    height: 100%;
    background: linear-gradient(90deg, #4caf50, #ffd54f, #ff7043);
    transition: width 0.06s linear;
  }
  .diag-events {
    margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }
  .diag-event { padding: 1px 0; }
  .diag-hint { margin-top: 6px; opacity: 0.6; }
  .version {
    text-align: center;
    font-size: 0.7rem;
    opacity: 0.5;
    padding: 4px 0 6px;
    font-variant-numeric: tabular-nums;
  }
</style>

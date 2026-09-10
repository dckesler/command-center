/** Headless smoke test for src/data/chat.ts (run: bun run spike/chat-smoke.ts). */
import { chatState, disposeChat, sendChat, subscribeChat } from "../src/data/chat.ts"

let events = 0
subscribeChat(() => {
  events++
})

await sendChat("Reply with exactly the single word: OK")
await sendChat("Now reply with exactly the single word: TWICE")

console.log(`store events emitted: ${events}`)
for (const item of chatState.items) {
  console.log(`[${item.role}] ${item.text.slice(0, 100)}`)
}
await disposeChat()

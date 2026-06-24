## 2024-05-18 - LLM Streaming DOM Thrashing
**Learning:** During Server-Sent Events (SSE) streaming of LLM generated text (like the care guide), parsing the *entire accumulated markdown* and assigning it to `innerHTML` on every single chunk event causes massive main-thread blocking ($O(n^2)$ complexity). This leads to choppy rendering and janky scrolling.
**Action:** Always wrap frequent UI update cycles driven by stream events in `requestAnimationFrame` (or use a throttler/debouncer) to coalesce updates to match the display refresh rate (~60Hz) rather than network chunk rate.

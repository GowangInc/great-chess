// bot-worker.js — browser ESM Web Worker wrapper around the engine bot.
// Receives {state, depth?, timeMs?, id?}; posts {move, id?} or {error, id?}.
// No DOM access. The guard keeps `import './bot-worker.js'` harmless in Node.
import { chooseBotMove } from './engine.js?v=3';

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (e) => {
    const data = e.data || {};
    const id = data.id;
    try {
      const move = chooseBotMove(data.state, { depth: data.depth, timeMs: data.timeMs });
      self.postMessage(id === undefined ? { move } : { move, id });
    } catch (err) {
      const error = String((err && err.message) || err);
      self.postMessage(id === undefined ? { error } : { error, id });
    }
  });
}

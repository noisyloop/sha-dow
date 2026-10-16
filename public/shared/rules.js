// Shared rules: imported by the browser (public/app.js) and the server (server.js).
// The server is the authority; the client copy only gives instant feedback.

export const MAX_CHARS = 280;
export const TTL_MS = 24 * 60 * 60 * 1000;

// Curated emoji handles. A fixed list (instead of free emoji input) blocks
// look-alike spoofing, ZWJ/variation-selector tricks and invisible characters.
export const EMOJIS = [
  '🦊', '🐺', '🦉', '🐙', '🦈', '🐝', '🦋', '🐢', '🦎', '🐍',
  '🦅', '🦇', '🐸', '🐼', '🐨', '🦁', '🐯', '🐻', '🐰', '🐧',
  '🦄', '🐲', '🦖', '🐳', '🦀', '🐌', '🐞', '🦂', '🕷', '🦩',
  '🍄', '🌵', '🌙', '⭐', '🔥', '⚡', '🌊', '❄', '🌈', '🍀',
  '🍕', '🍩', '🍉', '🍋', '🌶', '🥑', '🎲', '🎧', '🎸', '🚀',
  '🛸', '💎', '🔮', '🗝', '🧿', '🧩', '🎯', '👾', '🤖', '👻',
  '💀', '👽', '🎃', '🪐',
];
const EMOJI_SET = new Set(EMOJIS);
export const isValidEmoji = (e) => typeof e === 'string' && EMOJI_SET.has(e);

// Plain text only: letters, digits, space and light punctuation.
// No < > & " ` { } [ ] \ / = $ # % ^ * | ~ @ + _  -> no markup, code, URLs or templates.
const ALLOWED = /^[A-Za-z0-9 .,!?'():;-]*$/;
export const ALLOWED_HINT = "letters, numbers, space and . , ! ? ' ( ) : ; -";

// Strip anything outside the allowed set (used live while typing).
export const sanitizeInput = (s) =>
  s.replace(/[^A-Za-z0-9 .,!?'():;-]/g, '').replace(/ {2,}/g, ' ').slice(0, MAX_CHARS);

// Returns null if OK, otherwise a human-readable reason.
export function checkPlaintext(text) {
  if (typeof text !== 'string') return 'Invalid message.';
  const t = text.trim();
  if (!t) return 'Message is empty.';
  if (t.length > MAX_CHARS) return `Max ${MAX_CHARS} characters.`;
  if (!ALLOWED.test(t)) return `Only ${ALLOWED_HINT}.`;
  if (/ {2,}/.test(t)) return 'No repeated spaces.';
  for (const word of t.split(' ')) {
    // Blocks base64/hex/binary blobs, long tokens and pasted payloads.
    if (word.length > 24) return 'Words max 24 characters.';
    if (word.length >= 8 && /^[01]+$/.test(word)) return 'No pre-encoded binary.';
    if (word.length >= 12 && /^[0-9a-fA-F]+$/.test(word) && /\d/.test(word) && /[a-fA-F]/.test(word))
      return 'No hex blobs.';
    if (word.length >= 16 && /[A-Z]/.test(word) && /[a-z]/.test(word) && /\d/.test(word))
      return 'No encoded blobs.';
  }
  return null;
}

// Text <-> binary (8 bits per char, space-separated bytes). ASCII only by construction.
export const toBinary = (text) =>
  [...text].map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');

const BINARY = /^[01]{8}( [01]{8})*$/;

// Validates an incoming binary payload and returns the decoded plaintext, or null.
export function decodeBinary(bin) {
  if (typeof bin !== 'string' || bin.length > MAX_CHARS * 9 || !BINARY.test(bin)) return null;
  const text = bin.split(' ').map((b) => String.fromCharCode(parseInt(b, 2))).join('');
  return checkPlaintext(text) === null && text === text.trim() ? text : null;
}

function extractOTP(text) {
  if (!text) return null;
  const patterns = [
    /\b(\d{4,8})\b.{0,30}(?:code|otp|verification|pin|password)/i,
    /(?:code|otp|verification|pin|password)[^\d]{0,15}(\d{4,8})\b/i,
    /\b(\d{6})\b/,
    /\b(\d{4,8})\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

module.exports = { extractOTP };

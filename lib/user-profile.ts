const localProfiles = new Map<number, { nombre: string }>();

export async function getUserProfile(
  chatId: number,
  kv: { get: (key: string) => Promise<unknown>; set: (key: string, value: string, opts?: { ex: number }) => Promise<unknown> } | null
): Promise<{ nombre?: string } | null> {
  const key = `user:${chatId}:profile`;

  if (kv) {
    const stored = await kv.get(key);
    if (!stored) return null;
    return typeof stored === 'string' ? JSON.parse(stored) : stored;
  }

  return localProfiles.get(chatId) || null;
}

export async function saveUserProfile(
  chatId: number,
  nombre: string,
  kv: { get: (key: string) => Promise<unknown>; set: (key: string, value: string, opts?: { ex: number }) => Promise<unknown> } | null
): Promise<void> {
  const key = `user:${chatId}:profile`;
  const profile = { nombre: nombre.trim() };

  if (kv) {
    await kv.set(key, JSON.stringify(profile), { ex: 86400 * 365 });
  } else {
    localProfiles.set(chatId, profile);
  }
}

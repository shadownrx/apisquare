export type UserProfile = {
  nombre?: string;
  lastProfesional?: string;
  lastServicio?: string;
};

type KvLike = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: string, opts?: { ex: number }) => Promise<unknown>;
} | null;

const localProfiles = new Map<number, UserProfile>();

function parseStored(stored: unknown): UserProfile | null {
  if (!stored) return null;
  const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as UserProfile;
}

export async function getUserProfile(
  chatId: number,
  kv: KvLike
): Promise<UserProfile | null> {
  const key = `user:${chatId}:profile`;

  if (kv) {
    return parseStored(await kv.get(key));
  }

  return localProfiles.get(chatId) || null;
}

export async function saveUserProfile(
  chatId: number,
  patch: UserProfile | string,
  kv: KvLike
): Promise<void> {
  const key = `user:${chatId}:profile`;
  const incoming: UserProfile =
    typeof patch === 'string' ? { nombre: patch.trim() } : { ...patch };

  if (incoming.nombre) {
    incoming.nombre = incoming.nombre.trim();
  }

  const existing = (await getUserProfile(chatId, kv)) || {};
  const profile: UserProfile = {
    ...existing,
    ...incoming,
  };

  if (kv) {
    await kv.set(key, JSON.stringify(profile), { ex: 86400 * 365 });
  } else {
    localProfiles.set(chatId, profile);
  }
}

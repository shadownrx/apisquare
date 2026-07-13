import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { joinWaitlist } from '../lib/waitlist';

describe('joinWaitlist (local)', () => {
  beforeEach(() => {
    (global as any)._localWaitlist = new Map();
  });

  it('anota y no duplica la misma espera', async () => {
    const a = await joinWaitlist({
      chatId: 1,
      profesional: 'Javier Martoni',
      servicio: 'Sesión Premium',
      fecha: '2026-07-14',
    });
    assert.equal(a.ok, true);
    if (!a.ok) return;
    assert.equal(a.already, false);

    const b = await joinWaitlist({
      chatId: 1,
      profesional: 'Javier Martoni',
      servicio: 'Sesión Premium',
      fecha: '2026-07-14',
    });
    assert.equal(b.ok, true);
    if (!b.ok) return;
    assert.equal(b.already, true);
    assert.equal(b.entry.id, a.entry.id);
  });
});

// P2-227 review fixes (W2): the extra secret shapes the outgoing scan must hide.
// Fake key shapes are built from pieces, so no scanner mistakes this file for one holding a real key.
export const FAKE = {
  whsec: 'STRIPE_HOOK ' + 'wh' + 'sec_' + 'A1b2C3d4E5f6G7h8J9k0L1m2',
  sk_test: 'key ' + 'sk_' + 'test_' + 'A1b2C3d4E5f6G7h8J9k0',
  AIza: 'maps ' + 'AI' + 'za' + 'Sy' + 'A1b2C3d4E5f6G7h8J9k0L1m2N3o4P5q6R',
  xoxb: 'slack ' + 'xo' + 'xb-' + '1234567890-abcdefABCDEF',
  generic: 'STRIPE_WEBHOOK_' + 'SECRET=' + 'notreal123456',
  password: 'SMTP_' + 'PASSWORD: ' + 'hunter2hunter2',
};

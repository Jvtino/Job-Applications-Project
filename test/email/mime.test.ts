import { describe, expect, it } from 'vitest';
import { parseMessage, splitMbox } from '../../src/email/mime';

function makeMessage(headers: string[], body: string): string {
  return headers.join('\n') + '\n\n' + body;
}

describe('mime.parseMessage — transfer-encoding decode', () => {
  it('decodes quoted-printable (hex bytes, UTF-8, and soft line breaks)', () => {
    const qpBody = 'price=3D100 caf=C3=A9 soft=\nwrap';
    const msg = makeMessage(
      [
        'From: jobs-noreply@linkedin.com',
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: quoted-printable',
      ],
      qpBody,
    );
    const { html } = parseMessage(msg);
    expect(html).toContain('price=100'); // =3D -> '='
    expect(html).toContain('café'); // =C3=A9 -> é (UTF-8)
    expect(html).toContain('softwrap'); // soft break removed
  });

  it('decodes base64 bodies to UTF-8', () => {
    const original = '<b>Hello, Wörld</b> — 100% ✓';
    const b64 = Buffer.from(original, 'utf8').toString('base64');
    const msg = makeMessage(
      [
        'From: alert@indeed.com',
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
      ],
      b64,
    );
    expect(parseMessage(msg).html).toBe(original);
  });

  it('unfolds continued headers and lowercases header names', () => {
    const msg = makeMessage(
      ['From: alert@indeed.com', 'Subject: new jobs', '  for your search'],
      'body',
    );
    const { headers } = parseMessage(msg);
    expect(headers.get('subject')).toBe('new jobs for your search');
    expect(headers.get('from')).toBe('alert@indeed.com');
  });
});

describe('mime.splitMbox', () => {
  it('splits an mbox on From_ separator lines', () => {
    const mbox = [
      'From a@b.com Mon Jul 07 2026',
      'Subject: one',
      '',
      'body one',
      'From c@d.com Tue Jul 08 2026',
      'Subject: two',
      '',
      'body two',
    ].join('\n');
    const messages = splitMbox(mbox);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('Subject: one');
    expect(messages[1]).toContain('Subject: two');
    // The "From_" separator line itself is not part of the message body.
    expect(messages[0]).not.toContain('From a@b.com');
  });
});
